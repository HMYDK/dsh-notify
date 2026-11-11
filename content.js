/**
 * @hmydk/dsh-notify — notification text helpers.
 *
 * Pure functions that turn a session's derived message history into the short,
 * plain-text body shown in the notification. Kept apart from index.js so the
 * extraction can be tested without mounting the plugin. The browser half only
 * decides which field to show; all content formatting happens here.
 *
 * @module @hmydk/dsh-notify/content
 */

/** Raw input cap before formatting: replies can be long, previews never are. */
const RAW_LIMIT = 8000
/** Display cap for the one-line preview. */
const PREVIEW_LIMIT = 80
/** Below this length a first sentence is too thin to stand alone, so take more. */
const MIN_PREVIEW = 20

/** Plain text blocks of one message, joined; undefined when it has none. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  const text = parts.join('\n').trim()
  return text === '' ? undefined : text
}

/** Drop one line's markdown decoration: headings, quotes, bullets, numbering. */
function stripLineMarkers(line) {
  let value = line.trim()
  let previous
  do {
    previous = value
    value = value.replace(/^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/u, '')
  } while (value !== previous)
  return value
}

/** Strip markdown noise that reads badly in a one-line banner. */
function plainText(text) {
  return text
    .slice(0, RAW_LIMIT)
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`([^`\n]+)`/gu, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*([^*\n]+)\*\*/gu, '$1')
    .replace(/~~([^~\n]+)~~/gu, '$1')
    .split(/\r?\n/u)
    .map(stripLineMarkers)
    .filter((line) => line !== '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Bound one preview, clipping on a word boundary when the cut lands mid-word. */
function clipPreview(text) {
  if (text.length <= PREVIEW_LIMIT) return text
  let cut = text.slice(0, PREVIEW_LIMIT - 1)
  const next = text.charAt(PREVIEW_LIMIT - 1)
  const atWordBoundary = !/[\w\u4e00-\u9fff]/u.test(next) || cut.endsWith(' ')
  if (!atWordBoundary) {
    const space = cut.lastIndexOf(' ')
    if (space > PREVIEW_LIMIT - 24) cut = cut.slice(0, space)
  }
  return `${cut.trimEnd()}…`
}

/** One-line preview: first sentences up to the display cap. */
function previewOf(text) {
  const plain = plainText(text)
  if (plain === '') return undefined
  // Split after sentence punctuation so a short opening sentence can borrow the
  // next one. CJK punctuation needs no space after it; ASCII punctuation does.
  const sentences = plain.split(/(?<=[。！？!?；;])\s*/u).filter((sentence) => sentence !== '')
  let preview = sentences[0] ?? ''
  for (let index = 1; index < sentences.length && preview.length < MIN_PREVIEW; index += 1) {
    const glue = /[。！？；]$/u.test(preview) ? '' : ' '
    preview = `${preview}${glue}${sentences[index]}`
  }
  return clipPreview(preview)
}

/**
 * Summarize the conversation tail into a notification body.
 *
 * `prompt` is the latest direct human message (injected context carries a
 * non-`user` source kind and is ignored); `response` is the latest assistant
 * message with visible text that follows it. Both are display-ready one-liners;
 * the browser half falls back response → prompt → session title.
 *
 * @param messages - the session's derived model-visible messages, oldest first.
 * @returns {{ prompt?: string, response?: string }}
 */
export function summarizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return {}
  let promptIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && message?.source?.kind === 'user') {
      promptIndex = index
      break
    }
  }
  const prompt = promptIndex === -1 ? undefined : previewOf(textOfContent(messages[promptIndex].content) ?? '')
  let response
  for (let index = messages.length - 1; index > promptIndex; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const candidate = previewOf(textOfContent(message.content) ?? '')
    if (candidate !== undefined) {
      response = candidate
      break
    }
  }
  return { prompt, response }
}
