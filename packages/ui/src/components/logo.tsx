import { type ComponentProps } from "solid-js"
import koalaMark from "../assets/favicon/favicon-96x96-v3.png"

export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      src={koalaMark}
      alt=""
      aria-hidden="true"
      classList={{ [props.class ?? ""]: !!props.class }}
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      src={koalaMark}
      alt=""
      aria-hidden="true"
      classList={{ [props.class ?? ""]: !!props.class }}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="50%"
        y="50%"
        dominant-baseline="central"
        text-anchor="middle"
        font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        font-size="28"
        font-weight="700"
        letter-spacing="0.04em"
        fill="var(--text-base)"
      >
        Koala
      </text>
    </svg>
  )
}
