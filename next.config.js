/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence the "multiple lockfiles" workspace root warning
  outputFileTracingRoot: require('path').join(__dirname),
  // Allow the MLB Stats API domain for any future Image usage
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'statsapi.mlb.com' },
      { protocol: 'https', hostname: 'img.mlbstatic.com' },
    ],
  },
};

module.exports = nextConfig;
