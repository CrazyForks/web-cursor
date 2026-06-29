import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "浏览器内 AI React 编码沙箱",
  description: "Web Cursor 是一个浏览器内 AI React Playground：自然语言生成 React 代码，在隔离 iframe 沙箱即时运行，并把错误与 console 回传给 agent loop 自我修复。",
  alternates: {
    canonical: "/about",
  },
  openGraph: {
    title: "Web Cursor：浏览器内 AI React 编码沙箱",
    description: "自然语言生成 React 代码，即时执行预览，并把运行结果反馈给 agent loop 自我修复。",
    url: "/about",
  },
};

const capabilities = [
  {
    title: "自然语言到 React 代码",
    body: "用户描述想要的界面或交互，服务端代理调用 LLM，前端接收结果并落到项目文件。LLM key 只留在服务端，不进入浏览器。",
  },
  {
    title: "浏览器内即时预览",
    body: "主线程负责编辑器、编排和转译，React 代码在 iframe 沙箱中运行，预览结果不污染宿主页面。",
  },
  {
    title: "运行结果驱动自修复",
    body: "沙箱把 RENDER_OK、RUNTIME_ERROR 和 CONSOLE 回传给父窗口，agent loop 能基于真实运行反馈继续修复代码。",
  },
];

const architecture = [
  ["A 域", "Next.js Route Handler", "持有 API key，调用 LLM，并把结果转发给前端。"],
  ["B 域", "浏览器主线程", "承载编辑器、项目文件、agent loop、转译和预览控制。"],
  ["C 域", "iframe 沙箱", "执行 AI 生成的不可信代码，捕获错误与 console 后回传。"],
];

const stack = ["Next.js App Router", "TypeScript", "React", "Monaco Editor", "esbuild-wasm", "iframe sandbox", "Postgres / Drizzle", "OpenAI API"];

const timeline = [
  ["Thinking", "理解需求", "#dfa88f"],
  ["Reading", "读取文件", "#9fbbe0"],
  ["Editing", "生成代码", "#c0a8dd"],
  ["Grepping", "检查错误", "#9fc9a2"],
  ["Done", "预览成功", "#c08532"],
];

export default function AboutPage() {
  return (
    <main className="h-screen overflow-y-auto bg-[#050505] text-[#f7f7f4]">
      <section className="border-b border-[#24231f] bg-[#050505]">
        <div className="mx-auto flex min-h-[86vh] max-w-6xl flex-col px-5 py-5 sm:px-8 lg:px-10">
          <nav className="flex h-12 items-center justify-between gap-4 text-sm">
            <Link href="/" className="font-mono text-[13px] font-semibold text-[#f54e00] transition hover:text-[#ff6a2a]">
              Web Cursor
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-[#3a3832] bg-[#11110f] px-3 py-2 text-[13px] font-medium text-[#f7f7f4] transition hover:border-[#f54e00]"
            >
              打开工作台
            </Link>
          </nav>

          <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[0.92fr_1.08fr]">
            <div>
              <p className="mb-5 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a09c92]">AI React Playground</p>
              <h1 className="max-w-3xl text-4xl font-normal leading-[1.05] text-[#f7f7f4] sm:text-6xl lg:text-[72px]">
                浏览器内
                <br />
                AI React 沙箱
              </h1>
              <p className="mt-6 max-w-xl text-base leading-8 text-[#b8b4aa]">
                Web Cursor 用自然语言生成 React 代码，在浏览器沙箱中即时执行，并把报错、console 和渲染状态反馈给 agent loop，让 AI 对运行结果负责。
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/"
                  className="rounded-lg bg-[#f54e00] px-5 py-3 text-sm font-medium text-white transition hover:bg-[#d04200]"
                >
                  进入 Playground
                </Link>
                <a
                  href="#architecture"
                  className="rounded-lg border border-[#3a3832] bg-[#11110f] px-5 py-3 text-sm font-medium text-[#f7f7f4] transition hover:border-[#f54e00]"
                >
                  查看架构
                </a>
              </div>
            </div>

            <div className="rounded-xl border border-[#24231f] bg-[#0c0c0b]">
              <div className="flex items-center justify-between border-b border-[#24231f] px-4 py-3">
                <span className="font-mono text-[12px] text-[#807d72]">agent-loop.trace</span>
                <span className="rounded-full bg-[#1f8a65] px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                  Running
                </span>
              </div>
              <div className="grid min-h-[420px] gap-3 p-3 md:grid-cols-[0.64fr_0.36fr]">
                <div className="rounded-lg border border-[#24231f] bg-[#11110f] p-4 font-mono text-[12px] leading-6 text-[#a8a39a]">
                  <div className="mb-4 flex items-center gap-2 border-b border-[#24231f] pb-3 text-[#807d72]">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#f54e00]" />
                    <span>src/App.tsx</span>
                  </div>
                  <p>
                    <span className="text-[#c0a8dd]">export default</span> <span className="text-[#9fbbe0]">function</span>{" "}
                    <span className="text-[#f7f7f4]">App</span>() {"{"}
                  </p>
                  <p className="pl-4">
                    <span className="text-[#c0a8dd]">return</span> (
                  </p>
                  <p className="pl-8 text-[#9fc9a2]">&lt;main className="workspace"&gt;</p>
                  <p className="pl-12 text-[#f7f7f4]">AI writes. Sandbox runs.</p>
                  <p className="pl-12 text-[#dfa88f]">Errors become feedback.</p>
                  <p className="pl-8 text-[#9fc9a2]">&lt;/main&gt;</p>
                  <p className="pl-4">);</p>
                  <p>{"}"}</p>
                </div>

                <div className="flex flex-col gap-3">
                  <div className="rounded-lg border border-[#24231f] bg-[#11110f] p-4">
                    <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-[#807d72]">Agent timeline</div>
                    <div className="flex flex-wrap gap-2">
                      {timeline.map(([label, text, color]) => (
                        <span
                          key={label}
                          className="rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-[#26251e]"
                          style={{ backgroundColor: color }}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                    <div className="mt-4 space-y-2 text-sm text-[#b8b4aa]">
                      {timeline.map(([label, text]) => (
                        <div key={label} className="flex items-center justify-between border-t border-[#24231f] pt-2">
                          <span>{text}</span>
                          <span className="font-mono text-[11px] text-[#807d72]">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 rounded-lg border border-[#24231f] bg-[#11110f] p-4 font-mono text-[12px] leading-6">
                    <div className="text-[#9fc9a2]">sandbox.postMessage("RENDER_OK")</div>
                    <div className="mt-3 border-l border-[#3a3832] pl-3 text-[#807d72]">
                      RUNTIME_ERROR 会作为 tool result 回填到下一轮修复。
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-[#24231f] bg-[#0c0c0b] px-5 py-20 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-3xl font-normal leading-tight text-[#f7f7f4] sm:text-4xl">核心能力</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {capabilities.map((item) => (
              <article key={item.title} className="rounded-xl border border-[#24231f] bg-[#11110f] p-6">
                <h3 className="text-lg font-semibold text-[#f7f7f4]">{item.title}</h3>
                <p className="mt-4 text-sm leading-7 text-[#a8a39a]">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="architecture" className="border-b border-[#24231f] bg-[#050505] px-5 py-20 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-normal leading-tight text-[#f7f7f4] sm:text-4xl">三执行域架构</h2>
            <p className="mt-4 text-sm leading-7 text-[#a8a39a]">
              Web Cursor 把 LLM 代理、浏览器编排和代码执行沙箱分开。这个边界保证 API key 不进前端，也让 AI 生成的不可信代码被隔离执行。
            </p>
          </div>
          <div className="mt-8 overflow-x-auto rounded-xl border border-[#24231f]">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="bg-[#11110f] text-[#f7f7f4]">
                <tr>
                  <th className="border-b border-[#24231f] px-4 py-3 font-semibold">执行域</th>
                  <th className="border-b border-[#24231f] px-4 py-3 font-semibold">位置</th>
                  <th className="border-b border-[#24231f] px-4 py-3 font-semibold">职责</th>
                </tr>
              </thead>
              <tbody>
                {architecture.map(([domain, place, responsibility]) => (
                  <tr key={domain} className="bg-[#0c0c0b]">
                    <td className="border-b border-[#24231f] px-4 py-3 font-mono text-[#f54e00]">{domain}</td>
                    <td className="border-b border-[#24231f] px-4 py-3 text-[#f7f7f4]">{place}</td>
                    <td className="border-b border-[#24231f] px-4 py-3 leading-6 text-[#a8a39a]">{responsibility}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="bg-[#0c0c0b] px-5 py-20 sm:px-8 lg:px-10">
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <div>
            <h2 className="text-3xl font-normal leading-tight text-[#f7f7f4] sm:text-4xl">技术栈</h2>
            <p className="mt-4 text-sm leading-7 text-[#a8a39a]">
              项目目标不是套用现成 agent 框架，而是手写浏览器侧 agent loop，吃透从生成、执行、观察到修复的闭环。
            </p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {stack.map((item) => (
              <li key={item} className="rounded-lg border border-[#24231f] bg-[#11110f] px-4 py-3 font-mono text-[13px] text-[#b8b4aa]">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
