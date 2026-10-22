/**
 * Budgeted prompt rendering for the two memory layers.
 *
 * The invariant is that this function never exceeds its character budgets and
 * never hides the existence of omitted memories: the model must be told that
 * more is available, otherwise it answers "I don't remember" while memory sits
 * one tool call away.
 */

/** Short display date (MM-DD) from an ISO timestamp. */
function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  return match === null ? '' : `${match[2]}-${match[3]}`
}

/** Clip text to a character budget with an ellipsis. */
function clip(text, max) {
  if (max <= 0) return ''
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** One-line summary of an entry. */
function summaryLine(entry) {
  const date = shortDate(entry.updated)
  const flag = entry.pinned ? '·pinned' : ''
  return `- [${entry.type}${flag}] ${entry.title}${date === '' ? '' : `（${date}）`}`
}

/** Full body block for a pinned entry, indented under its summary line. */
function detailBlock(entry, max) {
  const body = clip(entry.body, max)
  const indented = body.split('\n').map((line) => (line === '' ? '' : `  ${line}`)).join('\n')
  return indented === '' ? [] : [indented]
}

/**
 * Render one layer within a character budget.
 * @param {object[]} entries - live entries, already sorted.
 * @param {{ budget: number, pinnedMax: number }} limits - layer limits.
 * @returns {{ lines: string[], shown: number, omitted: number }} rendered lines.
 */
function renderLayer(entries, limits) {
  const lines = []
  let used = 0
  let shown = 0
  const live = entries.filter((entry) => entry.supersededBy === null)
  for (const entry of live) {
    const head = summaryLine(entry)
    const detail = entry.pinned ? detailBlock(entry, limits.pinnedMax) : []
    const cost = [head, ...detail].join('\n').length + 1
    if (shown > 0 && used + cost > limits.budget) break
    const allowed = Math.max(0, limits.budget - used)
    const combined = [head, ...detail].join('\n')
    lines.push(combined.length <= allowed ? combined : clip(combined, allowed))
    used += Math.min(combined.length, allowed) + 1
    shown += 1
  }
  return { lines, shown, omitted: live.length - shown }
}

/**
 * Render both layers into the system-prompt text.
 * @param {object} input - rendering input.
 * @param {object[]} input.userEntries - user-layer entries.
 * @param {object[]} input.projectEntries - project-layer entries.
 * @param {string} input.projectLabel - project display name.
 * @param {boolean} input.includeUser - whether the user layer participates.
 * @param {{ userMaxChars: number, projectMaxChars: number, pinnedMaxChars: number }} input.limits - budgets.
 * @returns {string} rendered text, or an empty string when there is nothing to show.
 */
export function renderMemory(input) {
  const sections = []
  let omitted = 0
  if (input.includeUser) {
    const layer = renderLayer(input.userEntries ?? [], { budget: input.limits.userMaxChars, pinnedMax: input.limits.pinnedMaxChars })
    omitted += layer.omitted
    if (layer.lines.length > 0) sections.push(['## 用户层记忆（跨所有项目）', ...layer.lines].join('\n'))
  }
  const project = renderLayer(input.projectEntries ?? [], { budget: input.limits.projectMaxChars, pinnedMax: input.limits.pinnedMaxChars })
  omitted += project.omitted
  if (project.lines.length > 0) sections.push([`## 项目记忆 · ${input.projectLabel}`, ...project.lines].join('\n'))
  if (sections.length === 0) return ''
  const footer = omitted > 0 ? `\n\n另有 ${omitted} 条未注入：用 memory_list 列出索引，用 memory_recall 读取全文。` : ''
  return `## 持久记忆（跨 session）\n\n${sections.join('\n\n')}${footer}`
}
