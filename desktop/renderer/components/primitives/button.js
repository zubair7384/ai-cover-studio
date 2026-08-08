/**
 * Button and IconButton — §6.
 *
 * Primary is amber fill with near-black text. Destructive is text-only unless
 * `fill` is set, which the design system permits only inside a confirm sheet.
 */

import { el, cls, uid } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";
import { Spinner } from "./display.js";
import { attachTooltip } from "./overlay.js";

const VARIANTS = ["primary", "secondary", "tertiary", "destructive"];
const SIZES = { sm: "btn--sm", md: "btn--md", lg: "btn--lg" };

/**
 * @param {object} o
 * @param {string} o.label        visible text
 * @param {"primary"|"secondary"|"tertiary"|"destructive"} [o.variant="secondary"]
 * @param {"sm"|"md"|"lg"} [o.size="md"]
 * @param {string} [o.icon]       leading icon name
 * @param {string} [o.iconEnd]    trailing icon name
 * @param {boolean} [o.loading]   swaps content for a spinner, keeps width
 * @param {boolean} [o.disabled]
 * @param {boolean} [o.fill]      destructive only — filled treatment
 * @param {string} [o.tooltip]    explains WHY a disabled button is disabled
 * @param {Function} [o.onClick]
 */
export function Button({
  label,
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  loading = false,
  disabled = false,
  fill = false,
  tooltip,
  type = "button",
  onClick,
  ...rest
} = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`Button: bad variant "${variant}"`);

  const node = el("button", {
    type,
    class: cls(
      "btn",
      `btn--${variant}`,
      SIZES[size] || SIZES.md,
      variant === "destructive" && fill && "btn--destructive--fill",
      loading && "btn--loading"
    ),
    disabled: disabled || undefined,
    "aria-busy": loading ? "true" : undefined,
    ...rest,
  });

  if (icon) node.appendChild(makeIcon(icon, size === "sm" ? 12 : 14, "btn__icon"));
  node.appendChild(el("span", { class: "btn__label" }, label));
  if (iconEnd) node.appendChild(makeIcon(iconEnd, size === "sm" ? 12 : 14, "btn__icon"));

  if (loading) {
    node.appendChild(el("span", { class: "btn__spinner" }, Spinner({ size: 14 })));
  }

  if (onClick) node.addEventListener("click", onClick);

  // A disabled button swallows pointer events, so the tooltip has to live on a
  // wrapper. Prompt 4 relies on this to explain a disabled "Generate".
  if (tooltip) {
    if (disabled) {
      const wrap = el("span", { class: "btn-wrap", style: { display: "inline-flex" } }, node);
      attachTooltip(wrap, tooltip);
      return wrap;
    }
    attachTooltip(node, tooltip);
  }

  return node;
}

/**
 * Icon-only button. `label` is REQUIRED — §11 mandates an aria-label and a
 * tooltip on every icon-only control.
 */
export function IconButton({
  icon,
  label,
  size = "md",
  active = false,
  disabled = false,
  tooltip = true,
  onClick,
  ...rest
} = {}) {
  if (!label) throw new Error("IconButton: `label` is required (aria-label + tooltip)");

  const px = size === "sm" ? 14 : size === "lg" ? 18 : 16;
  const node = el("button", {
    type: "button",
    class: cls(
      "icon-btn",
      size === "sm" && "icon-btn--sm",
      size === "lg" && "icon-btn--lg",
      active && "icon-btn--active"
    ),
    "aria-label": label,
    "aria-pressed": active ? "true" : undefined,
    disabled: disabled || undefined,
    ...rest,
  }, makeIcon(icon, px));

  if (onClick) node.addEventListener("click", onClick);
  if (tooltip) attachTooltip(node, typeof tooltip === "string" ? tooltip : label);
  return node;
}

/**
 * Segmented control — used for Original/Cover A/B and the theme picker.
 * @param {Array<{value:string,label:string}>} options
 */
export function Segmented({ options = [], value, onChange, ariaLabel } = {}) {
  const name = uid("seg");
  const root = el("div", {
    class: "segmented",
    role: "radiogroup",
    "aria-label": ariaLabel || "Options",
  });

  options.forEach((opt) => {
    const btn = el("button", {
      type: "button",
      role: "radio",
      class: cls("segmented__item", opt.value === value && "segmented__item--on"),
      "aria-checked": opt.value === value ? "true" : "false",
      dataset: { value: opt.value, name },
    }, opt.label);

    btn.addEventListener("click", () => {
      if (opt.value === value) return;
      value = opt.value;
      [...root.children].forEach((c) => {
        const on = c.dataset.value === value;
        c.classList.toggle("segmented__item--on", on);
        c.setAttribute("aria-checked", on ? "true" : "false");
      });
      onChange?.(value);
    });
    root.appendChild(btn);
  });

  return root;
}
