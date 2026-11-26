interface ShardProps {
  size: number
  /** Makes the ember core glow; used when mail or a meeting needs attention. */
  alert?: boolean
}

/** Narsil's avatar: a faceted steel shard with an ember core. */
export function Shard({ size, alert = false }: ShardProps): React.JSX.Element {
  return (
    <svg
      className={alert ? 'shard shard--alert' : 'shard'}
      width={size}
      height={size * 1.25}
      viewBox="0 0 80 100"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#C9D6E3" />
          <stop offset="0.55" stopColor="#6F8FB3" />
          <stop offset="1" stopColor="#2E4561" />
        </linearGradient>
        <radialGradient id="ember" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFF4D6" />
          <stop offset="0.45" stopColor="#F3B23C" />
          <stop offset="1" stopColor="#F3B23C" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon points="40,2 66,34 56,98 24,98 14,34" fill="url(#steel)" />
      <polygon points="40,2 66,34 40,46" fill="#E4ECF4" opacity="0.55" />
      <polygon points="14,34 40,46 24,98" fill="#1F3148" opacity="0.35" />
      <polyline points="40,2 40,46 56,98" fill="none" stroke="#E9F0F7" strokeWidth="0.8" opacity="0.6" />
      <circle className="shard__core" cx="40" cy="56" r="16" fill="url(#ember)" />
    </svg>
  )
}
