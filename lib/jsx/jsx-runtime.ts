/**
 * The JSX runtime entry point (`jsxImportSource: "#jsx"` in tsconfig, mapped
 * by package.json `imports`). Bun's transform emits calls to `jsx`/`jsxs`;
 * the implementation lives in `lib/Html.ts`.
 */
import { Fragment as HtmlFragment, type Child, type Html, jsx as make } from "../Html.ts"

export { raw, render } from "../Html.ts"
export type { Child, Component, Html } from "../Html.ts"

export const jsx = make
/** Multiple children; the runtime treats them identically to `jsx`. */
export const jsxs = make
export const jsxDEV = make
export const Fragment = HtmlFragment

type Attribute = string | number | boolean | null | undefined

/** Attributes any element may carry: the global ones, plus `data-*`,
 * `aria-*`, and `hx-*` so htmx can be written inline without ceremony. */
interface Attributes {
  readonly children?: Child
  readonly class?: Attribute
  readonly id?: Attribute
  readonly style?: Attribute
  readonly title?: Attribute
  readonly lang?: Attribute
  readonly role?: Attribute
  readonly [key: `data-${string}`]: Attribute
  readonly [key: `aria-${string}`]: Attribute
  readonly [key: `hx-${string}`]: Attribute
}

export declare namespace JSX {
  type Element = Html
  interface ElementChildrenAttribute {
    children: {}
  }
  interface IntrinsicElements {
    readonly [tag: string]: Attributes & Record<string, Attribute | Child>
  }
}
