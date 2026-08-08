/**
 * Form controls — TextField, Select, Slider, Toggle, Checkbox. §6.
 *
 * Every control returns a wrapper node with an `.input` property pointing at
 * the real input element, so callers can read/write value without re-querying.
 */

import { el, cls, uid } from "../../lib/dom.js";
import { icon as makeIcon } from "../../lib/icons.js";
import { Readout } from "./display.js";

/**
 * Shared label / help / error scaffolding.
 *
 * The real input is exposed as `node.input` — NOT `node.control`, which is a
 * read-only accessor on HTMLLabelElement and throws for Toggle and Checkbox.
 */
function wrap({ id, label, help, error }, control) {
  const node = el("div", { class: "field" });
  if (label) node.appendChild(el("label", { class: "field__label", for: id }, label));
  node.appendChild(control);
  if (help) node.appendChild(el("div", { class: "field__help", id: `${id}-help` }, help));
  const errNode = el("div", { class: "field__error", id: `${id}-error`, role: "alert" });
  if (error) {
    errNode.appendChild(makeIcon("alert", 11));
    errNode.appendChild(document.createTextNode(error));
  } else {
    errNode.hidden = true;
  }
  node.appendChild(errNode);
  node.input = control;
  node.errorNode = errNode;

  /** Set or clear the inline error after construction (live validation). */
  node.setError = (msg) => {
    errNode.innerHTML = "";
    if (msg) {
      errNode.appendChild(makeIcon("alert", 11));
      errNode.appendChild(document.createTextNode(msg));
      errNode.hidden = false;
      control.classList.add("input--invalid");
      control.setAttribute("aria-invalid", "true");
    } else {
      errNode.hidden = true;
      control.classList.remove("input--invalid");
      control.removeAttribute("aria-invalid");
    }
  };
  return node;
}

/* ---- TextField ---------------------------------------------------------- */

export function TextField({
  label, value = "", placeholder, help, error, type = "text",
  disabled = false, search = false, onInput, onChange, ariaLabel, ...rest
} = {}) {
  const id = uid("tf");
  const input = el("input", {
    id, type, value, placeholder,
    class: cls("input", error && "input--invalid"),
    disabled: disabled || undefined,
    "aria-label": !label ? (ariaLabel || placeholder) : undefined,
    "aria-describedby": help ? `${id}-help` : undefined,
    ...rest,
  });
  if (onInput) input.addEventListener("input", (e) => onInput(e.target.value, e));
  if (onChange) input.addEventListener("change", (e) => onChange(e.target.value, e));

  if (search) {
    const box = el("div", { class: "search" },
      el("span", { class: "search__icon" }, makeIcon("search", 14)),
      input,
    );
    // Esc clears the field (§ Prompt 1 toolbar behaviour).
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        e.stopPropagation();
        input.value = "";
        onInput?.("", e);
      }
    });
    const node = wrap({ id, label, help, error }, box);
    node.input = input;
    return node;
  }

  return wrap({ id, label, help, error }, input);
}

/* ---- Select ------------------------------------------------------------- */

export function Select({
  label, options = [], value, help, error, disabled = false, onChange, ariaLabel,
} = {}) {
  const id = uid("sel");
  const sel = el("select", {
    id,
    disabled: disabled || undefined,
    "aria-label": !label ? ariaLabel : undefined,
    "aria-describedby": help ? `${id}-help` : undefined,
  });

  options.forEach((o) => {
    const opt = typeof o === "string" ? { value: o, label: o } : o;
    sel.appendChild(el("option", {
      value: opt.value,
      selected: opt.value === value || undefined,
    }, opt.label));
  });
  if (value != null) sel.value = String(value);
  if (onChange) sel.addEventListener("change", (e) => onChange(e.target.value, e));

  const box = el("div", { class: "select" },
    sel,
    el("span", { class: "select__chevron" }, makeIcon("chevron-down", 14)),
  );
  const node = wrap({ id, label, help, error }, box);
  node.input = sel;
  return node;
}

/* ---- Slider ------------------------------------------------------------- */

/**
 * @param {Function} [o.format]  value -> readout string, e.g. v => `${v} st`
 * @param {Array<{value:number,label:string}>} [o.ticks]
 */
export function Slider({
  label, min = 0, max = 100, step = 1, value = 0,
  format = (v) => String(v), help, ticks, disabled = false, onInput,
} = {}) {
  const id = uid("sl");
  const readout = Readout({ text: format(value) });
  readout.classList.add("slider__value");

  const input = el("input", {
    id, type: "range", min, max, step, value,
    disabled: disabled || undefined,
    "aria-describedby": help ? `${id}-help` : undefined,
    "aria-valuetext": format(value),
  });

  const setPct = (v) => {
    const pct = ((v - min) / (max - min)) * 100;
    input.style.setProperty("--pct", `${pct}%`);
  };
  setPct(value);

  input.addEventListener("input", (e) => {
    const v = Number(e.target.value);
    setPct(v);
    readout.textContent = format(v);
    input.setAttribute("aria-valuetext", format(v));
    onInput?.(v, e);
  });

  const node = el("div", { class: "slider" },
    el("div", { class: "slider__top" },
      label ? el("label", { class: "field__label", for: id }, label) : el("span"),
      readout,
    ),
    input,
  );

  if (ticks?.length) {
    node.appendChild(append_ticks(ticks));
  }
  if (help) node.appendChild(el("div", { class: "field__help", id: `${id}-help` }, help));

  node.input = input;
  node.setValue = (v) => {
    input.value = String(v);
    setPct(v);
    readout.textContent = format(v);
  };
  return node;
}

function append_ticks(ticks) {
  const row = el("div", { class: "slider__ticks t-caption tabular", "aria-hidden": "true" });
  ticks.forEach((t) => row.appendChild(el("span", {}, t.label ?? String(t.value ?? t))));
  return row;
}

/* ---- Toggle ------------------------------------------------------------- */

export function Toggle({ label, checked = false, disabled = false, onChange } = {}) {
  const input = el("input", {
    type: "checkbox",
    checked: checked || undefined,
    disabled: disabled || undefined,
    role: "switch",
    "aria-label": label || undefined,
  });
  if (onChange) input.addEventListener("change", (e) => onChange(e.target.checked, e));

  const node = el("label", { class: "toggle" },
    input,
    el("span", { class: "toggle__track" }, el("span", { class: "toggle__thumb" })),
    label ? el("span", { class: "toggle__label t-body" }, label) : null,
  );
  node.input = input;
  return node;
}

/* ---- Checkbox ----------------------------------------------------------- */

export function Checkbox({
  label, checked = false, indeterminate = false, disabled = false, onChange,
} = {}) {
  const input = el("input", {
    type: "checkbox",
    checked: checked || undefined,
    disabled: disabled || undefined,
    "aria-label": !label ? "Checkbox" : undefined,
  });
  if (indeterminate) input.indeterminate = true;
  if (onChange) input.addEventListener("change", (e) => onChange(e.target.checked, e));

  const box = el("span", { class: "checkbox__box" },
    makeIcon(indeterminate ? "minus" : "check", 11),
  );

  const node = el("label", { class: "checkbox" },
    input,
    box,
    label ? el("span", { class: "checkbox__label" }, label) : null,
  );
  node.input = input;
  return node;
}
