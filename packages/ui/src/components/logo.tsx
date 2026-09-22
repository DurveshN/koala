import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="3" cy="7.2" r="2.2" fill="var(--icon-base)" />
      <circle cx="13" cy="7.2" r="2.2" fill="var(--icon-base)" />
      <circle cx="3" cy="7.2" r="1.1" fill="var(--icon-weak-base)" />
      <circle cx="13" cy="7.2" r="1.1" fill="var(--icon-weak-base)" />
      <circle cx="8" cy="10.8" r="5.8" fill="var(--icon-base)" />
      <circle cx="6" cy="10.4" r="0.7" fill="var(--icon-strong-base)" />
      <circle cx="10" cy="10.4" r="0.7" fill="var(--icon-strong-base)" />
      <ellipse cx="8" cy="12.4" rx="1.5" ry="1.9" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="15" cy="36" r="11" fill="var(--icon-base)" />
      <circle cx="65" cy="36" r="11" fill="var(--icon-base)" />
      <circle cx="15" cy="36" r="5.5" fill="var(--icon-weak-base)" />
      <circle cx="65" cy="36" r="5.5" fill="var(--icon-weak-base)" />
      <circle cx="40" cy="54" r="29" fill="var(--icon-base)" />
      <circle cx="30" cy="52" r="3.5" fill="var(--icon-strong-base)" />
      <circle cx="50" cy="52" r="3.5" fill="var(--icon-strong-base)" />
      <ellipse cx="40" cy="62" rx="7.5" ry="9.5" fill="var(--icon-strong-base)" />
    </svg>
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
