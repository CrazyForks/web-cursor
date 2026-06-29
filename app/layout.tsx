import type { Metadata } from "next";
import { SITE_URL } from "@/lib/site";
import "highlight.js/styles/github-dark.css";
import "./globals.css";

const title = "Web Cursor · AI React Playground";
const description = "浏览器内的 AI React 编码沙箱：自然语言生成 React 代码，即时执行预览，并把运行结果回传给 agent loop 自我修复。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: title,
    template: "%s · Web Cursor",
  },
  description,
  applicationName: "Web Cursor",
  keywords: [
    "Web Cursor",
    "AI React Playground",
    "AI coding sandbox",
    "React coding playground",
    "浏览器 AI 编码沙箱",
    "AI 代码生成",
    "agent loop",
  ],
  authors: [{ name: "Siuming" }],
  creator: "Siuming",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Web Cursor",
    title,
    description,
    locale: "zh_CN",
  },
  twitter: {
    card: "summary",
    title,
    description,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
