export function Sparkline({
  data,
  positive,
  width = 64,
  height = 22,
}: {
  data: number[]
  positive: boolean
  width?: number
  height?: number
}) {
  if (data.length === 0) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const step = width / (data.length - 1)
  const points = data
    .map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - min) / range) * height).toFixed(2)}`)
    .join(' ')

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={positive ? 'var(--up)' : 'var(--down)'}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
