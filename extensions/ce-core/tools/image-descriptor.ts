import { complete } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { readPiPedstackConfig } from "../utils/config-types"

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

export function registerImageDescriptorHook(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    // Check if there are attached images
    const images = (event as any).images as ImageContent[] | undefined
    if (!images || images.length === 0) {
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

    const model = ctx.modelRegistry.find(provider, modelId)
    if (!model) {
      console.warn(`[pi-pedstack] Vision model ${provider}/${modelId} not found. Skipping image description.`)
      return undefined
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
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

    for (let i = 0; i < images.length; i++) {
      const img = images[i]
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

      const newPrompt = event.prompt + "\n\n" + appendedDescriptions

      return {
        prompt: newPrompt,
      }
    }

    return undefined
  })
}
