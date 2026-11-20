// Form primitives: one visual + behavioural contract for every input in the
// app. Existing pages keep their `.form` layout; only the controls change.

import * as SelectPrimitive from "@radix-ui/react-select";
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { IconCheck, IconChevronDown } from "../components/icons";
import { t } from "../i18n";

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="ui-field">
      <span className="field-label">
        {label}
        {required && <span className="ui-required">*</span>}
      </span>
      {children}
      {error ? (
        <span className="ui-error">{error}</span>
      ) : hint ? (
        <span className="ui-hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className="ui-input" aria-invalid={invalid || undefined} {...rest} />;
}

export function Textarea({
  invalid,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea className="ui-input ui-textarea" aria-invalid={invalid || undefined} {...rest} />;
}

export interface SelectOption {
  value: string;
  label: string;
  /** Optional leading glyph (emoji or icon element). */
  leading?: ReactNode;
  disabled?: boolean;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = t("common.choose"),
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger className="ui-input ui-select-trigger" aria-label={ariaLabel}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <IconChevronDown size={12} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content className="ui-select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="ui-select-item"
              >
                {o.leading != null && <span className="ui-select-leading">{o.leading}</span>}
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="ui-select-check">
                  <IconCheck size={13} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}