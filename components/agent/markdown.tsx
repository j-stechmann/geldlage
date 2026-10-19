"use client"

import { createContext, memo, type JSX, useContext } from "react"
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import rehypeHighlight from "rehype-highlight"

/**
 * Shared markdown renderer for every chat text (ADR-0033): persisted and
 * streamed assistant content, user bubbles, the Denkprozess trace and tool
 * chip payloads — one component so none of them can drift apart.
 *
 * Styling avoids theme-dependent tokens (bg-muted vs. bg-primary bubbles)
 * by building on `foreground`-opacity and `currentColor`: the same map
 * works on both bubble variants without a variant prop. Raw HTML is
 * ignored by react-markdown's default (safe: no rehype-raw, no sanitizer),
 * and images are disallowed entirely: chat is text formatting, not media,
 * so model-generated `![](...)` never triggers a remote fetch.
 *
 * remark-breaks preserves the single-newline line breaks the plain-text
 * renderer used to show (chat users type hard breaks, markdown would
 * collapse them). rehype-highlight runs with `detect: false` — only fenced
 * blocks with an explicit language get colored, so streamed German prose
 * and fence-less JSON are never mis-detected and live re-parses stay cheap.
 */

/**
 * Custom components receive the hast element as `node`; a DOM element
 * would render it as an invalid `node="[object Object]"` attribute.
 */
type ElementProps = { node?: ExtraProps["node"] }

/** Omits hast `node` from the props passed to the intrinsic element. */
function nodeless<T extends ElementProps>(props: T): Omit<T, "node"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- named to omit it
  const { node, ...rest } = props
  return rest
}

/**
 * Fenced code is always a direct child of `pre`; inline code never is. The
 * `pre` override marks its subtree so `Code` can tell bare block code
 * apart from the inline chip — including a fence without a declared
 * language, which carries no `language-*` class and can be single-line.
 */
const InPre = createContext(false)

function Code(props: JSX.IntrinsicElements["code"] & ElementProps) {
  const block = useContext(InPre)
  return (
    <code
      {...nodeless(props)}
      // keep hljs/language-* classes (highlight targeting, semantics)
      className={
        (block
          ? "font-mono text-xs "
          : "rounded-sm bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em] ") +
        (props.className ?? "")
      }
    />
  )
}

const components: Components = {
  p: (props) => (
    <p {...nodeless(props)} className="my-1.5 first:mt-0 last:mb-0" />
  ),
  /**
   * Headings stay bubble-sized: no browser-default 2em blow-ups inside the
   * text-sm/text-xs bubbles. em-based so they scale with the parent size
   * (text-sm bubbles, text-xs Denkprozess); h3–h6 collapse to body weight.
   */
  h1: (props) => (
    <h1
      {...nodeless(props)}
      className="my-1.5 text-[1.15em] font-semibold first:mt-0 last:mb-0"
    />
  ),
  h2: (props) => (
    <h2
      {...nodeless(props)}
      className="my-1.5 text-[1.05em] font-semibold first:mt-0 last:mb-0"
    />
  ),
  h3: (props) => (
    <h3
      {...nodeless(props)}
      className="my-1.5 font-semibold first:mt-0 last:mb-0"
    />
  ),
  h4: (props) => (
    <h4
      {...nodeless(props)}
      className="my-1.5 font-semibold first:mt-0 last:mb-0"
    />
  ),
  h5: (props) => (
    <h5
      {...nodeless(props)}
      className="my-1.5 font-semibold first:mt-0 last:mb-0"
    />
  ),
  h6: (props) => (
    <h6
      {...nodeless(props)}
      className="my-1.5 font-semibold first:mt-0 last:mb-0"
    />
  ),
  ul: (props) => (
    <ul
      {...nodeless(props)}
      className="my-1.5 list-disc pl-5 marker:text-foreground/50 first:mt-0 last:mb-0"
    />
  ),
  ol: (props) => (
    <ol
      {...nodeless(props)}
      className="my-1.5 list-decimal pl-5 marker:text-foreground/50 first:mt-0 last:mb-0"
    />
  ),
  blockquote: (props) => (
    <blockquote
      {...nodeless(props)}
      className="my-1.5 border-l-2 border-foreground/30 pl-2 first:mt-0 last:mb-0"
    />
  ),
  hr: (props) => (
    <hr {...nodeless(props)} className="my-2 border-foreground/20" />
  ),
  /** Fenced source: bg/overflow live on the pre, the code child stays bare. */
  pre: (props) => (
    <InPre.Provider value={true}>
      <pre
        {...nodeless(props)}
        className="my-1.5 overflow-x-auto rounded-lg bg-foreground/10 p-2 font-mono text-xs leading-relaxed first:mt-0 last:mb-0"
      />
    </InPre.Provider>
  ),
  a: (props) => (
    <a
      {...nodeless(props)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline underline-offset-2"
    />
  ),
  table: (props) => (
    <div className="my-1.5 overflow-x-auto">
      <table
        {...nodeless(props)}
        className="w-full border-collapse text-left text-xs [&_td]:border [&_td]:border-foreground/15 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border [&_th]:border-foreground/15 [&_th]:bg-foreground/5 [&_th]:px-1.5 [&_th]:py-1 [&_th]:font-semibold"
      />
    </div>
  ),
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div
      className={
        "min-w-0 [overflow-wrap:anywhere]" + (className ? ` ${className}` : "")
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        disallowedElements={["img"]}
        components={{ ...components, code: Code }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
