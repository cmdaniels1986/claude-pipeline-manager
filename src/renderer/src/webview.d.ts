import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/** The subset of Electron's <webview> tag API the live preview pane uses.
 *  (The renderer tsconfig doesn't pull in electron's types — keep this minimal.) */
export interface PreviewWebviewElement extends HTMLElement {
  src: string
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  executeJavaScript(code: string): Promise<unknown>
  openDevTools(): void
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<PreviewWebviewElement> & {
          src?: string
          partition?: string
          allowpopups?: string
          webpreferences?: string
        },
        PreviewWebviewElement
      >
    }
  }
}
