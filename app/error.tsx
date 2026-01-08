"use client"

import { useEffect } from "react"

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }, reset: () => void }) {
  useEffect(() => {
    console.error("[GlobalError]", error)
  }, [error])

  return (
    <html>
      <body style={{ padding: 24, color: "#fff", background: "#000" }}>
        <h1 style={{ fontSize: 24, marginBottom: 12 }}>发生错误</h1>
        <p style={{ opacity: 0.8, marginBottom: 16 }}>请刷新页面或稍后重试。</p>
        <button onClick={() => reset()} style={{ padding: "8px 12px", background: "#333", color: "#fff", borderRadius: 6 }}>
          重试
        </button>
      </body>
    </html>
  )
}



