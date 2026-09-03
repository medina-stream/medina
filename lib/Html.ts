/**
 * Server-rendered JSX: components are plain functions returning `Html`, and
 * rendering is string concatenation. Bun compiles the JSX; nothing ships to
 * the browser.
 *
 * Escaping is the point. Interpolated strings are escaped on the way in, so
 * a transcript containing `<script>` cannot become markup. `raw()` is the
 * single documented escape hatch, and it is deliberately noisy to write.
 */

declare const HtmlBrand: unique symbol

/** Markup that is already escaped and safe to emit verbatim. */
export interface Html {
  readonly [HtmlBrand]: true
  readonly value: string
}

export type Child = Html | string | number | false | null | undefined | ReadonlyArray<Child>

const html = (value: string): Html => ({ value }) as Html

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
}

export const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ESCAPES[character]!)

/** Trust a string as markup. Only for markup this code built itself. */
export const raw = (value: string): Html => html(value)

export const isHtml = (value: unknown): value is Html =>
  typeof value === "object" && value !== null && "value" in value && typeof (value as Html).value === "string"

export const render = (child: Child): string => {
  if (child === null || child === undefined || child === false) return ""
  if (Array.isArray(child)) return child.map(render).join("")
  if (isHtml(child)) return child.value
  return escape(String(child))
}

/** Void elements have no closing tag and no children. */
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
])

const attributes = (props: Record<string, unknown>) => {
  let out = ""
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || value === null || value === undefined || value === false) continue
    // `hx-get`, `data-*`, `aria-*` and friends pass through as written.
    if (!/^[A-Za-z_][A-Za-z0-9_:.-]*$/.test(name)) continue
    if (value === true) {
      out += ` ${name}`
      continue
    }
    out += ` ${name}="${escape(String(value))}"`
  }
  return out
}

export type Component<P = {}> = (props: P) => Child

/** The JSX factory: intrinsic tags become markup, components are called. */
export const jsx = (
  type: string | Component<any>,
  props: Record<string, unknown> | null
): Html => {
  const resolved = props ?? {}
  if (typeof type === "function") return html(render(type(resolved)))
  const children = render(resolved["children"] as Child)
  if (VOID.has(type)) return html(`<${type}${attributes(resolved)}>`)
  return html(`<${type}${attributes(resolved)}>${children}</${type}>`)
}

/** `<>...</>` — children only, no wrapper element. */
export const Fragment = (props: { children?: Child }): Html => html(render(props.children))
