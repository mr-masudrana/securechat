import { useState } from 'react'
import Icon from './Icon'
import { raw } from './i18n'
import { tokenize, type Card } from './linkparse'

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation() // বাবলের সোয়াইপ/মেনু যেন না ধরে

function ExtLink({ href, className, children }: { href: string; className: string; children: any }) {
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow" onClick={stop} className={className}>{children}</a>
}

// YouTube: প্রথমে কিছুই লোড হয় না (থাম্বনেইলও না), তাই ট্যাপের আগে YouTube আপনার আইপি জানে না
function YouTubeCard({ id, start, href }: { id: string; start: number; href: string }) {
  const [play, setPlay] = useState(false)
  if (play) {
    return (
      <div className="w-72 max-w-full space-y-1">
        <iframe title="YouTube" className="w-full aspect-video rounded-lg bg-black"
          src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${start ? '&start=' + start : ''}`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" />
        <ExtLink href={href} className="block text-xs underline text-white/70">YouTube-এ খুলুন</ExtLink>
      </div>
    )
  }
  return (
    <div className="w-72 max-w-full rounded-lg bg-black/25 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="size-9 shrink-0 rounded-lg bg-red-600 grid place-items-center"><Icon name="play" className="size-4 text-white" /></span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">YouTube ভিডিও</p>
          <p className="text-[11px] text-white/60">চালালে আপনার ডিভাইস সরাসরি YouTube-এর সঙ্গে যুক্ত হবে</p>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={e => { stop(e); setPlay(true) }} className="flex-1 rounded-lg bg-red-600 py-1.5 text-sm font-semibold">ভিডিও চালান</button>
        <ExtLink href={href} className="flex-1 rounded-lg bg-white/10 py-1.5 text-sm text-center">YouTube-এ খুলুন</ExtLink>
      </div>
    </div>
  )
}

function SocialCard({ c }: { c: Extract<Card, { kind: 'social' }> }) {
  return (
    <ExtLink href={c.href} className="flex w-72 max-w-full items-center gap-2 rounded-lg bg-black/25 p-2.5">
      <span style={{ background: c.color }} className="size-9 shrink-0 rounded-lg grid place-items-center text-sm font-bold text-white ring-1 ring-white/20">{c.label[0]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{c.label}</span>
        <span className="block text-[11px] text-white/60 truncate">{c.shown}</span>
      </span>
      <span className="text-xs text-white/70 shrink-0">খুলুন</span>
    </ExtLink>
  )
}

// মেসেজের লেখা: লিংক ক্লিকযোগ্য, @username ট্যাপে প্রোফাইল, YouTube/সোশ্যাল লিংকের নিচে কার্ড
export function RichText({ text, onMention }: { text: string; onMention: (name: string) => void }) {
  const segs = tokenize(text)
  const cards: Card[] = []
  for (const s of segs) {
    if (s.t === 'link' && s.card && cards.length < 3 && !cards.some(c => c.href === s.card!.href)) cards.push(s.card)
  }
  return (
    <>
      <p className="whitespace-pre-wrap">
        {segs.map((s, i) => s.t === 'text' ? raw(s.s)
          : s.t === 'mention' ? (
            <button key={i} onClick={e => { stop(e); onMention(s.name) }} className="font-semibold underline decoration-dotted underline-offset-2">@{s.name}</button>
          ) : (
            <span key={i}>
              {s.suspicious && <span title="সন্দেহজনক ডোমেইন (অস্বাভাবিক অক্ষর)">⚠ </span>}
              <ExtLink href={s.href} className="underline underline-offset-2 text-sky-200 break-all">{s.shown}</ExtLink>
            </span>
          ))}
      </p>
      {cards.map(c => c.kind === 'yt'
        ? <YouTubeCard key={c.href} id={c.id} start={c.start} href={c.href} />
        : <SocialCard key={c.href} c={c} />)}
    </>
  )
}
