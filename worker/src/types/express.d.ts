// Minimal surface of `express` used by worker/src/dashboard.ts (Bull Board).
// @types/express is not installed; declaring only what the dashboard calls
// keeps the worker entry type-checked without changing the shared lockfile.
declare module 'express' {
  export interface Response {
    json(body: unknown): void
  }
  export type Handler = (req: unknown, res: Response) => void
  export interface Express {
    use(path: string, handler: unknown): Express
    get(path: string, handler: Handler): Express
    listen(port: number, callback?: () => void): unknown
  }
  export default function express(): Express
}
