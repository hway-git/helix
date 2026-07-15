/** @type {import('next').NextConfig} */
const daemonOrigin = process.env.HELIX_DAEMON_URL || 'http://127.0.0.1:8787'

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/api/:path*',
          destination: `${daemonOrigin}/api/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    }
  },
}

export default nextConfig
