"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/utils/ui";
import { EASINGS, FONTS, type ParamSpec } from "../types";

const fieldClass =
	"bg-background border-line w-full rounded-[10px] border px-2.5 py-1.5 text-sm text-bone outline-none focus:border-[#5a5a63]";

function isSimpleList(spec: ParamSpec): boolean {
	return spec.type === "list" && !!spec.of && ["string", "text", "number", "color"].includes(spec.of.type);
}

function isObjectList(spec: ParamSpec): boolean {
	return spec.type === "list" && spec.of?.type === "object" && !!spec.of.fields && Object.values(spec.of.fields).every(isSimpleField);
}

function isSimpleField(spec: ParamSpec): boolean {
	return ["string", "text", "number", "color", "boolean", "enum", "easing", "font", "image"].includes(spec.type);
}

/** "add at least 3 cards", "type the word": what a required param still needs, or null when it is filled. */
export function missingHint(spec: ParamSpec, value: unknown, name: string): string | null {
	const noun = (spec.label ?? name).toLowerCase();
	if (spec.type === "list") {
		const count = Array.isArray(value) ? value.length : 0;
		const min = Math.max(1, spec.minItems ?? 1);
		if (count >= min) return null;
		return min === 1 ? `add at least one ${noun.replace(/s$/, "")}` : `add at least ${min} ${noun}${count ? ` (${count} so far)` : ""}`;
	}
	if (spec.type === "number") return typeof value === "number" && Number.isFinite(value) ? null : `set ${noun}`;
	if (spec.type === "object") return value && typeof value === "object" ? null : `fill in ${noun}`;
	if (spec.type === "image") return typeof value === "string" && value.trim() ? null : `add ${noun}`;
	if (spec.type === "boolean") return null;
	return typeof value === "string" && value.trim() ? null : `type the ${noun}`;
}

/**
 * One param of a composition, rendered by its spec type (CONTRACT.md §2). Lists of simple objects (Orbit's cards)
 * edit as rows of fields; other objects/lists as JSON. `required` marks it, `error` shows under it (QA #9).
 */
export function ParamField({
	name,
	spec,
	value,
	onChange,
	required = false,
	error,
}: {
	name: string;
	spec: ParamSpec;
	value: unknown;
	onChange: (value: unknown) => void;
	required?: boolean;
	error?: string | null;
}) {
	const label = spec.label ?? name;
	const id = `rc-param-${name}`;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-baseline justify-between gap-2">
				<label htmlFor={id} className="text-[0.8rem] font-medium text-bone">
					{label}
					{required && <span className="text-fog ml-1.5 rc-mono text-[0.62rem] uppercase tracking-[.1em]">needed</span>}
				</label>
				<span className="rc-mono text-fog text-[0.65rem]">
					{spec.type === "number" && spec.unit ? spec.unit : isObjectList(spec) ? "list" : spec.type}
				</span>
			</div>
			<FieldInput id={id} spec={spec} value={value} onChange={onChange} invalid={Boolean(error)} />
			{error ? (
				<p role="alert" className="text-stale text-[0.72rem] leading-snug">
					{error}
				</p>
			) : null}
			{spec.description && (
				<p className="text-fog text-[0.72rem] leading-snug">{spec.description}</p>
			)}
		</div>
	);
}

/** A list of objects with simple fields (Orbit's cards): one row per item, add / remove, an empty-state hint. */
function ObjectListField({
	id,
	spec,
	value,
	onChange,
	invalid,
}: {
	id: string;
	spec: ParamSpec;
	value: unknown;
	onChange: (value: unknown) => void;
	invalid: boolean;
}) {
	const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
	const fields = Object.entries(spec.of?.fields ?? {}).filter(([, field]) => field.type !== "image");
	const noun = (spec.label ?? "item").toLowerCase().replace(/s$/, "");
	const max = spec.maxItems ?? 20;
	const blank = () =>
		Object.fromEntries(Object.entries(spec.of?.fields ?? {}).filter(([, field]) => field.type !== "image" && field.default !== undefined && field.default !== "").map(([key, field]) => [key, field.default]));
	const update = (index: number, key: string, next: unknown) => onChange(items.map((item, i) => (i === index ? { ...item, [key]: next } : item)));
	return (
		<div id={id} className={cn("border-line flex flex-col gap-2 rounded-[10px] border p-2", invalid && "border-stale/60")}>
			{items.length === 0 ? (
				<p className="text-fog px-1 py-1.5 text-[0.75rem]">
					No {noun}s yet{spec.minItems ? ` — add at least ${spec.minItems}` : ""}.
				</p>
			) : (
				items.map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids; order is the identity
					<div key={index} className="bg-background flex flex-col gap-1.5 rounded-[8px] p-2">
						<div className="flex items-center justify-between">
							<span className="rc-mono text-fog text-[0.62rem] uppercase tracking-[.1em]">
								{noun} {index + 1}
							</span>
							<button
								type="button"
								className="rc-mono text-fog hover:text-bone cursor-pointer text-[0.66rem]"
								aria-label={`Remove ${noun} ${index + 1}`}
								onClick={() => onChange(items.filter((_, i) => i !== index))}
							>
								remove
							</button>
						</div>
						<div className="grid grid-cols-2 gap-1.5">
							{fields.map(([key, field]) => (
								<label key={key} className={cn("flex flex-col gap-0.5", field.type === "text" && "col-span-2")}>
									<span className="text-fog text-[0.66rem]">{field.label ?? key}</span>
									<FieldInput id={`${id}-${index}-${key}`} spec={field} value={item[key] ?? field.default} onChange={(next) => update(index, key, next)} invalid={false} />
								</label>
							))}
						</div>
					</div>
				))
			)}
			<button
				type="button"
				disabled={items.length >= max}
				className="rc-pill h-7 self-start px-2.5 text-[0.72rem]"
				onClick={() => onChange([...items, blank()])}
			>
				+ Add {noun}
			</button>
		</div>
	);
}

function FieldInput({
	id,
	spec,
	value,
	onChange,
	invalid = false,
}: {
	id: string;
	spec: ParamSpec;
	value: unknown;
	onChange: (value: unknown) => void;
	invalid?: boolean;
}) {
	if (isObjectList(spec)) return <ObjectListField id={id} spec={spec} value={value} onChange={onChange} invalid={invalid} />;
	switch (spec.type) {
		case "string":
		case "image":
			return (
				<input
					id={id}
					className={fieldClass}
					value={typeof value === "string" ? value : ""}
					maxLength={spec.maxLength}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "text":
			return (
				<textarea
					id={id}
					className={cn(fieldClass, "min-h-16 resize-y")}
					value={typeof value === "string" ? value : ""}
					maxLength={spec.maxLength}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "number":
			return (
				<input
					id={id}
					type="number"
					className={cn(fieldClass, "rc-mono")}
					value={typeof value === "number" ? value : ""}
					min={spec.min}
					max={spec.max}
					step={spec.step ?? "any"}
					onChange={(event) => {
						const n = Number(event.target.value);
						if (event.target.value !== "" && Number.isFinite(n)) onChange(n);
					}}
				/>
			);
		case "color":
			return (
				<div className="flex items-center gap-2">
					<input
						type="color"
						aria-label="pick a colour"
						className="border-line size-8 shrink-0 cursor-pointer rounded-[8px] border bg-transparent p-0.5"
						value={typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
						onChange={(event) => onChange(event.target.value.toUpperCase())}
					/>
					<input
						id={id}
						className={cn(fieldClass, "rc-mono")}
						value={typeof value === "string" ? value : ""}
						onChange={(event) => onChange(event.target.value)}
					/>
				</div>
			);
		case "boolean":
			return (
				<Switch
					id={id}
					checked={value === true}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "enum":
		case "easing":
		case "font": {
			const options =
				spec.type === "enum"
					? (spec.options ?? [])
					: spec.type === "easing"
						? [...EASINGS]
						: [...FONTS];
			return (
				<select
					id={id}
					className={cn(fieldClass, "cursor-pointer")}
					value={typeof value === "string" ? value : ""}
					onChange={(event) => onChange(event.target.value)}
				>
					{options.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			);
		}
		default:
			return isSimpleList(spec) ? (
				<LinesField id={id} spec={spec} value={value} onChange={onChange} />
			) : (
				<JsonField id={id} value={value} onChange={onChange} />
			);
	}
}

/** A list of simple values, one per line. */
function LinesField({
	id,
	spec,
	value,
	onChange,
}: {
	id: string;
	spec: ParamSpec;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const parse = (raw: string) => {
		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		return spec.of?.type === "number" ? lines.map(Number) : lines;
	};
	const asText = Array.isArray(value) ? value.map(String).join("\n") : "";
	const [text, setText] = useState(asText);
	// Only take the outside value when it differs from what this box already says (keeps a half-typed new line).
	useEffect(() => {
		setText((current) =>
			JSON.stringify(parse(current)) === JSON.stringify(value ?? []) ? current : asText,
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asText]);
	return (
		<textarea
			id={id}
			className={cn(fieldClass, "min-h-20 resize-y")}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				onChange(parse(event.target.value));
			}}
		/>
	);
}

/** Lists of objects and objects: edited as JSON, applied when it parses. */
function JsonField({
	id,
	value,
	onChange,
}: {
	id: string;
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const asText = JSON.stringify(value ?? null, null, 1);
	const [text, setText] = useState(asText);
	const [bad, setBad] = useState(false);
	useEffect(() => {
		setText((current) => {
			try {
				if (JSON.stringify(JSON.parse(current)) === JSON.stringify(value ?? null)) return current;
			} catch {
				// fall through: take the outside value
			}
			return asText;
		});
		setBad(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [asText]);
	return (
		<textarea
			id={id}
			spellCheck={false}
			className={cn(fieldClass, "rc-mono min-h-28 resize-y text-[0.72rem] leading-snug", bad && "border-[#e5484d]")}
			value={text}
			onChange={(event) => {
				setText(event.target.value);
				try {
					onChange(JSON.parse(event.target.value));
					setBad(false);
				} catch {
					setBad(true);
				}
			}}
		/>
	);
}
