import type { EngineInterface as Dollar, Register } from 'claude-code'

const COMPACT = 'compact'
const USAGE = 'context_usage'
const COMPACT_TOOL = `mcp__self-compact__${COMPACT}`
const USAGE_TOOL = `mcp__self-compact__${USAGE}`

// Fill levels (percent of the auto-compact limit) at which Claude is told once.
const BANDS = [50, 70, 85, 95]

type Fill = { tokens?: number; limit: number; window: number; autoAt?: number; pct?: number }
type Pending = { instructions?: string; resume?: string }

let autoAt: number | undefined
let warnedBand = -1
let pending: Pending | undefined
// The job whose /compact is queued or running; its resume note goes out once the compaction lands.
let inFlight: Pending | undefined

const k = (n: number) => `${Math.round(n / 1000)}k`

async function refreshAutoAt($: Dollar) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    autoAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
  } catch {
    autoAt = undefined
  }
}

async function fill($: Dollar): Promise<Fill> {
  const { context } = await $.session.usage()
  const limit = autoAt ?? context.window
  const pct = context.tokens === undefined ? undefined : Math.round((context.tokens / limit) * 100)
  return { tokens: context.tokens, limit, window: context.window, autoAt, pct }
}

function describe(f: Fill) {
  if (f.tokens === undefined) return 'Context: not measured yet (no response since start or last compaction).'
  const against = f.autoAt ? `of ${k(f.limit)} before auto-compact; window ${k(f.window)}` : `of ${k(f.window)} window; auto-compact off`
  return `Context: ${f.pct}% full (${k(f.tokens)} ${against}).`
}

function status($: Dollar, f: Fill) {
  $.ui.status(f.pct === undefined ? undefined : `ctx ${f.pct}%${inFlight ? ' · compacting' : pending ? ' · compact queued' : ''}`)
}

function bandOf(pct: number | undefined) {
  if (pct === undefined) return -1
  let band = -1
  BANDS.forEach((b, i) => { if (pct >= b) band = i })
  return band
}

function warning(f: Fill, band: number) {
  const head = `[self-compact] ${describe(f)}`
  if (band >= 3) return `${head} Auto-compaction is imminent and will cut in wherever you are. At the very next breakpoint, call ${COMPACT_TOOL} with a resume note, then end your turn.`
  if (band >= 2) return `${head} Plan to compact soon: finish the current step, then call ${COMPACT_TOOL} with a resume note.`
  return `${head} No action needed yet; ${COMPACT_TOOL} is available when you reach a natural breakpoint.`
}

const trail: string[] = []

// Visible in the transcript and kept for context_usage, so a stuck compaction says where.
function trace($: Dollar, msg: string) {
  trail.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
  if (trail.length > 20) trail.shift()
  $.ui.log(`self-compact: ${msg}`)
}

function resumeText(job: Pending) {
  const note = job.resume?.trim()
  return note
    ? `The conversation was compacted at your request. Your note to yourself before compacting:\n\n${note}\n\nContinue from there.`
    : 'The conversation was compacted at your request. Continue where you left off.'
}

// $.session.compact() rejects with "a turn is running" from a turn.complete hook and its timers
// (measured 2026-10-20 in the desktop app), so queue /compact instead: the engine runs a
// queued command once the session is idle. command.run resolves when the command is queued, not
// when it has run (2026-10-20: a resume sent then arrived a minute before the compaction), so the
// resume note goes out from the session.compact hook instead.
async function runCompaction($: Dollar, job: Pending): Promise<void> {
  if (pending !== job) return
  // Claim it before awaiting: another turn.complete in the meantime must not queue it again.
  pending = undefined
  inFlight = job
  try {
    trace($, 'queueing /compact for when the session is idle')
    await $.command.run({ command: 'compact', args: job.instructions ?? '' })
  } catch (err) {
    if (inFlight === job) inFlight = undefined
    trace($, `could not compact: ${String(err).slice(0, 200)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: COMPACT,
      description:
        'Compact (summarize) this conversation to free context, at a moment you choose. ' +
        'Compaction runs right after your current turn ends, then a new turn starts with your resume note. ' +
        'So: call this at a natural breakpoint (a step finished, state written down), then end your turn with a one-line message. ' +
        'Put in `resume` exactly what you need to continue (task, what is done, next action, key paths); ' +
        'put in `instructions` what the summary must preserve. [self-compact] reminders tell you how full the context is.',
      inputSchema: {
        type: 'object',
        properties: {
          resume: { type: 'string', description: 'Note to your post-compaction self: goal, progress, the exact next action.' },
          instructions: { type: 'string', description: 'What the summary should keep or stress (like text after /compact).' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: USAGE,
      description: 'Report how full the context window is, and how far from auto-compaction.',
      isDeferred: false,
    })
    await refreshAutoAt($)
    try { status($, await fill($)) } catch {}
    return next(e)
  })

  on('tool.call', { tool: 'mcp__self-compact__compact' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main conversation can compact itself.' }
    const input = e as unknown as Pending
    pending = { instructions: input.instructions, resume: input.resume }
    const f = await fill($)
    status($, f)
    return {
      result:
        `Compaction queued: it runs as soon as this turn ends, then you continue with your resume note. ${describe(f)} ` +
        'End your turn now with a short message; do not start new work.',
    }
  }).catch(() => ({ deny: 'self-compact: could not queue the compaction.' }))

  on('tool.call', { tool: 'mcp__self-compact__context_usage' }, async $ => {
    const f = await fill($)
    status($, f)
    const queued = pending ? ' A compaction is queued for the end of this turn.' : ''
    const log = trail.length ? `\nRecent self-compact events:\n${trail.join('\n')}` : ''
    return { result: describe(f) + queued + log }
  }).catch(() => ({ deny: 'self-compact: could not read context usage.' }))

  // After every main-loop tool call: refresh the status line, and tell Claude once per band crossed.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined) return ran
    try {
      const f = await fill($)
      status($, f)
      const band = bandOf(f.pct)
      if (band > warnedBand && !pending && e.tool !== COMPACT_TOOL) {
        warnedBand = band
        return { ...ran, context: [...(ran.context ?? []), warning(f, band)] }
      }
    } catch {}
    return ran
  }).catch(($, e, next) => next(e))

  // Each prompt the person sends past the first band carries the current fill.
  on('prompt.submit', async ($, e, next) => {
    try {
      const f = await fill($)
      const band = bandOf(f.pct)
      if (band >= 0) {
        warnedBand = Math.max(warnedBand, band)
        return next({ ...e, context: [...(e.context ?? []), warning(f, band)] })
      }
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const job = pending
    if (job && e.isAborted) {
      pending = undefined
      $.ui.toast('self-compact: turn interrupted, queued compaction cancelled')
    } else if (job) {
      trace($, 'turn.complete seen, compaction scheduled')
      $.clock.after(300, () => void runCompaction($, job))
    }
    try { status($, await fill($)) } catch {}
    return done
  })

  // Any compaction (manual, auto, ours) resets the warnings.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger !== 'precompute' && e.agentId === undefined && done.skip === undefined) {
      warnedBand = -1
      await refreshAutoAt($)
      const job = inFlight
      if (job) {
        inFlight = undefined
        try { status($, await fill($)) } catch {}
        trace($, `compacted (${e.trigger}); resuming`)
        // After the hook returns, so the prompt queues behind the finished compaction.
        $.clock.after(0, () => void $.prompt.submit({ text: resumeText(job) }).catch(err => trace($, `resume not sent: ${String(err).slice(0, 200)}`)))
      }
    }
    return done
  }).catch(($, e, next) => next(e))
}
