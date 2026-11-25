// অ্যাপ খোলা অবস্থার ছোট শব্দ ও পছন্দ
export const soundOn = () => localStorage.getItem('pref:sound') !== 'off'
export const setSound = (on: boolean) => localStorage.setItem('pref:sound', on ? 'on' : 'off')

let ctx: AudioContext | null = null
export function beep() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime
    o.frequency.value = 880
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25)
    o.connect(g).connect(ctx.destination)
    o.start(t)
    o.stop(t + 0.26)
  } catch { /* শব্দ না হলে ক্ষতি নেই */ }
}
