import React from 'react'

export default function Card(props: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #1f1f1f', borderRadius: 16, background: '#0b0b0b', padding: 14 }}>
      <div style={{ fontWeight: 950, marginBottom: 10 }}>{props.title}</div>
      {props.children}
    </div>
  )
}
