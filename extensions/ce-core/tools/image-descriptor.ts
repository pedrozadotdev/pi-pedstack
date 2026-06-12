import { complete } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { readPiPedstackConfig } from "../utils/config-types"

function detectSupportedImageMimeType(buffer: Buffer): string | null {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png"
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif"
  }
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

async function detectSupportedMimeType(filePath: string): Promise<string | null> {
  try {
    const fd = fs.openSync(filePath, "r")
    let mime: string | null = null
    try {
      const buffer = Buffer.alloc(12)
      const bytesRead = fs.readSync(fd, buffer, 0, 12, 0)
      if (bytesRead >= 3) {
        mime = detectSupportedImageMimeType(buffer.subarray(0, bytesRead) as Buffer)
      }
    } finally {
      fs.closeSync(fd)
    }
    if (mime) return mime
  } catch {
    // ignore
  }

  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".png") return "image/png"
  if (ext === ".gif") return "image/gif"
  if (ext === ".webp") return "image/webp"

  return null
}

function computeHash(base64Data: string): string {
  return crypto.createHash("sha256").update(base64Data).digest("hex")
}

function parseModelRef(
  modelRef: string,
  currentProvider?: string,
): { provider: string; id: string } | null {
  const trimmed = modelRef.trim()
  if (!trimmed) return null

  const slashIndex = trimmed.indexOf("/")
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slashIndex),
      id: trimmed.slice(slashIndex + 1),
    }
  }

  if (!currentProvider) return null
  return {
    provider: currentProvider,
    id: trimmed,
  }
}

export interface ImageDescriptorInput {
  imagePath: string
  prompt?: string
}

export function createImageDescriptorTool() {
  return {
    name: "image_descriptor",
    async execute(input: ImageDescriptorInput, ctx: any): Promise<string> {
      let rawPath = input.imagePath
      if (rawPath.startsWith("@")) {
        rawPath = rawPath.slice(1)
      }
      const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath)

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Image file not found: ${resolvedPath}`)
      }
      const mimeType = await detectSupportedMimeType(resolvedPath)
      if (!mimeType) {
        throw new Error(`Unsupported image type for file: ${resolvedPath}`)
      }
      const base64Data = fs.readFileSync(resolvedPath).toString("base64")

      // Read config
      const config = await readPiPedstackConfig(ctx.cwd)
      const descriptorConfig = config?.imageDescriptor

      let provider = "google"
      let modelId = "gemini-2.5-flash"
      let thinkingLevel = "off"

      if (descriptorConfig?.model) {
        const parsed = parseModelRef(descriptorConfig.model, ctx.model?.provider)
        if (parsed) {
          provider = parsed.provider
          modelId = parsed.id
        }
      } else if (ctx.model?.input.includes("image")) {
        provider = ctx.model.provider
        modelId = ctx.model.id
      }

      if (descriptorConfig?.thinkingLevel) {
        thinkingLevel = descriptorConfig.thinkingLevel
      }

      let model = ctx.modelRegistry.find(provider, modelId)
      let auth = model ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : null

      if (!model || !auth || !auth.ok || !auth.apiKey) {
        const available = ctx.modelRegistry.getAvailable()
        const fallbackModel = available.find((m: any) => m.input.includes("image"))
        if (fallbackModel) {
          model = fallbackModel
          provider = fallbackModel.provider
          modelId = fallbackModel.id
          auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
        }
      }

      if (!model) {
        throw new Error(`No vision-capable model found.`)
      }
      if (!auth || !auth.ok || !auth.apiKey) {
        throw new Error(`API key not configured for vision model ${provider}/${modelId}.`)
      }

      // Cache lookups
      const cachePath = path.join(os.homedir(), ".pi", "pi-pedstack", "image-cache.json")
      let cache: Record<string, string> = {}
      try {
        const cacheContent = fs.readFileSync(cachePath, "utf8")
        cache = JSON.parse(cacheContent)
      } catch {
        // ignore
      }

      const hash = computeHash(base64Data)
      if (cache[hash]) {
        return cache[hash]
      }

      const imagePromptText = input.prompt || "Provide a detailed, clear description of this image for a text-only assistant. Describe any code, UI components, text, diagrams, layout, and visual details present in the image."

      const messagePrompt = {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: imagePromptText,
          },
          {
            type: "image" as const,
            data: base64Data,
            mimeType,
          },
        ],
        timestamp: Date.now(),
      }

      const response = await complete(
        model,
        { messages: [messagePrompt] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          reasoning: thinkingLevel as any,
        },
      )

      const textOutput = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
        .trim()

      if (textOutput) {
        cache[hash] = textOutput
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true })
          fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8")
        } catch {
          // ignore
        }
        return textOutput
      } else {
        throw new Error("Empty response from vision model.")
      }
    }
  }
}

export function registerImageDescriptorHook(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const hasVision = ctx.model?.input?.includes("image") ?? false

    if (!hasVision) {
      const suggestion = "\n\n[Suggestion]: You do not have native vision capabilities. If the user attaches or references an image (using @filename format or via attachments), you must use the 'image_descriptor' tool to describe the image's contents before attempting to answer or reason about it."
      return {
        systemPrompt: event.systemPrompt + suggestion,
      }
    }

    return undefined
  })
}
