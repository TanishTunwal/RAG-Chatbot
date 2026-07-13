/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  allowedDevOrigins: ["localhost", "127.0.0.1", "192.168.56.1"],
};

export default nextConfig;