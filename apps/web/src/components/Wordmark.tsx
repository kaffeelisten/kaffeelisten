// The logotype. "Kaffee" in the foreground ink, "listen" in the accent, the colour
// changing mid-word with no gap.
//
// Why this is a component and not two spans typed out wherever the name appears:
// the split IS the recognition device, and four slightly different versions of our
// own name across four surfaces is worse than one plain version everywhere. One
// place to change, one place to be wrong.
//
// Why the second half follows `accent` rather than a fixed brand amber: decided by
// the owner on 25 November 2026. A customer can rebrand the accent, so on their
// instance the logotype takes their colour. The device is the split, not the hue -
// and on our own surfaces the accent is the brand amber, so the demo and the
// default install read exactly as the brand book draws them.

interface WordmarkProps {
  /** Classes for the whole logotype: size, weight, tracking. */
  className?: string
}

export default function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={className}>
      Kaffee<span className="text-accent">listen</span>
    </span>
  )
}
