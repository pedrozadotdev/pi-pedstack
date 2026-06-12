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
    try {
      const buffer = Buffer.alloc(12)
      const bytesRead = fs.readSync(fd, buffer, 0, 12, 0)
      if (bytesRead < 3) return null
      return detectSupportedImageMimeType(buffer.subarray(0, bytesRead) as Buffer)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
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

export interface ImageContent {
  type: "image"
  data: string
  mimeType: string
}

async function parseImagesFromPrompt(
  prompt: string | undefined,
  cwd: string,
): Promise<ImageContent[]> {
  if (!prompt) return []

  const parsedImages: ImageContent[] = []
  const pathRegex = /(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g
  const matches = Array.from(prompt.matchAll(pathRegex))

  for (const match of matches) {
    const rawPath = match[1] || match[2] || match[3]
    if (!rawPath) continue

    try {
      const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath)
      let mimeType = await detectSupportedMimeType(resolvedPath)
      let finalPath = resolvedPath

      if (!mimeType) {
        const trimmedPath = rawPath.replace(/[.,?!;:()\]}]+$/, "")
        if (trimmedPath !== rawPath) {
          const resolvedTrimmed = path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(cwd, trimmedPath)
          mimeType = await detectSupportedMimeType(resolvedTrimmed)
          if (mimeType) {
            finalPath = resolvedTrimmed
          }
        }
      }

      if (mimeType && fs.existsSync(finalPath)) {
        const data = fs.readFileSync(finalPath).toString("base64")
        parsedImages.push({ type: "image", data, mimeType })
      }
    } catch {
      // ignore
    }
  }

  return parsedImages
}

function deduplicateImages(
  images: ImageContent[],
  parsedImages: ImageContent[],
): ImageContent[] {
  const allImages: ImageContent[] = []
  const seenData = new Set<string>()

  for (const img of images) {
    if (img.data && !seenData.has(img.data)) {
      seenData.add(img.data)
      allImages.push(img)
    }
  }

  for (const img of parsedImages) {
    if (img.data && !seenData.has(img.data)) {
      seenData.add(img.data)
      allImages.push(img)
    }
  }

  return allImages
}

export function registerImageDescriptorHook(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // Parse prompt for image references and combine with any attached images
    const images = (event as any).images as ImageContent[] | undefined
    const parsedImages = await parseImagesFromPrompt(event.prompt, ctx.cwd)
    const allImages = deduplicateImages(images || [], parsedImages)

    if (allImages.length === 0) {
      return undefined
    }

    // Read pi-pedstack config for image descriptor
    const config = await readPiPedstackConfig(ctx.cwd)
    const descriptorConfig = config?.imageDescriptor

    // If not configured, default to google/gemini-2.5-flash or fall back to current model if it supports images
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
      // Find fallback model that supports image inputs
      const available = ctx.modelRegistry.getAvailable()
      const fallbackModel = available.find((m) => m.input.includes("image"))
      if (fallbackModel) {
        model = fallbackModel
        provider = fallbackModel.provider
        modelId = fallbackModel.id
        auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
      }
    }

    if (!model) {
      console.warn(`[pi-pedstack] Vision model ${provider}/${modelId} not found. Skipping image description.`)
      return undefined
    }

    if (!auth || !auth.ok || !auth.apiKey) {
      console.warn(`[pi-pedstack] API key not found for vision model ${provider}/${modelId}. Skipping image description.`)
      return undefined
    }

    // Load cache
    const cachePath = path.join(os.homedir(), ".pi", "pi-pedstack", "image-cache.json")
    let cache: Record<string, string> = {}
    try {
      const cacheContent = fs.readFileSync(cachePath, "utf8")
      cache = JSON.parse(cacheContent)
    } catch {
      // ignore
    }

    const descriptions: string[] = []

    for (let i = 0; i < allImages.length; i++) {
      const img = allImages[i]
      const hash = computeHash(img.data)

      if (cache[hash]) {
        descriptions.push(cache[hash])
        continue
      }

      // Generate description using vision model
      try {
        const messagePrompt = {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: "Provide a detailed, clear description of this image for a text-only assistant. Describe any code, UI components, text, diagrams, layout, and visual details present in the image.",
            },
            {
              type: "image" as const,
              data: img.data,
              mimeType: img.mimeType,
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
          descriptions.push(textOutput)
        } else {
          descriptions.push(`[Image #${i + 1} Description could not be generated: empty response]`)
        }
      } catch (err: any) {
        console.error(`[pi-pedstack] Failed to describe image #${i + 1}:`, err)
        descriptions.push(`[Image #${i + 1} Description could not be generated: ${err.message || err}]`)
      }
    }

    // Save cache if updated
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8")
    } catch {
      // ignore
    }

    if (descriptions.length > 0) {
      // Format the fence-tagged image descriptions to append to user prompt
      const appendedDescriptions = descriptions
        .map((desc, idx) => `<!-- IMAGE_DESCRIPTION_START index=${idx} -->\n[Attached Image #${idx + 1} Description]:\n${desc}\n<!-- IMAGE_DESCRIPTION_END -->`)
        .join("\n\n")

      return {
        systemPrompt: event.systemPrompt + "\n\n" + appendedDescriptions,
      }
    }

    return undefined
  })
}
