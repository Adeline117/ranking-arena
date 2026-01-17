import 'react'

declare module 'react' {
  interface StyleHTMLAttributes<T> extends React.HTMLAttributes<T> {
    jsx?: boolean
    global?: boolean
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      style: React.DetailedHTMLProps<
        React.StyleHTMLAttributes<HTMLStyleElement> & {
          jsx?: boolean
          global?: boolean
        },
        HTMLStyleElement
      >
    }
  }
}

export {}
