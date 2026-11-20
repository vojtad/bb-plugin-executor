import { type ReactElement, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type ApprovalField,
  approvalPayloadSchema,
  type ApprovalResponse,
} from "../../contract.js";

type Value = string | number | boolean;

function toContent(fields: readonly ApprovalField[], values: Record<string, string | boolean>): ApprovalResponse["content"] {
  const content: Record<string, Value> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "") continue;
    content[field.name] = field.type === "number" || field.type === "integer" ? Number(value) : value;
  }
  return content;
}

export function ApprovalPrompt({ interaction, submit, cancel }: PluginPendingInteractionProps): ReactElement {
  const [answering, setAnswering] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const parsed = approvalPayloadSchema.safeParse(interaction.payload);

  if (!parsed.success) {
    return (
      <div className="rounded-md border border-border bg-card p-3 text-sm">
        Executor asked for something this prompt cannot show. Nothing was approved.
        <Button size="sm" variant="outline" className="ml-2" onClick={() => { void cancel(); }}>
          Dismiss
        </Button>
      </div>
    );
  }
  const { message, tool, fields } = parsed.data;

  const decide = (decision: ApprovalResponse["decision"]): void => {
    if (answering) return;
    setAnswering(true);
    void submit({ decision, content: decision === "deny" ? {} : toContent(fields, values) })
      .catch(() => { setAnswering(false); });
  };

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-foreground">
        {message}
      </pre>

      {fields.map((field) => (
        <div key={field.name} className="mt-2 flex flex-col gap-1">
          {field.type === "boolean" ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`field-${field.name}`}
                checked={values[field.name] === true}
                onCheckedChange={(checked) => { setValues({ ...values, [field.name]: checked === true }); }}
              />
              <Label htmlFor={`field-${field.name}`}>{field.title}</Label>
            </div>
          ) : (
            <>
              <Label htmlFor={`field-${field.name}`}>{field.title}{field.required ? " *" : ""}</Label>
              {field.options !== null ? (
                <Select
                  value={String(values[field.name] ?? "")}
                  onValueChange={(value) => { setValues({ ...values, [field.name]: value }); }}
                >
                  <SelectTrigger id={`field-${field.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`field-${field.name}`}
                  type={field.type === "string" ? "text" : "number"}
                  value={String(values[field.name] ?? "")}
                  onChange={(event) => { setValues({ ...values, [field.name]: event.target.value }); }}
                />
              )}
            </>
          )}
        </div>
      ))}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={answering} onClick={() => { decide("once"); }}>
          {tool === null ? "Submit" : "Approve"}
        </Button>
        {tool !== null ? (
          <Button size="sm" variant="outline" disabled={answering} onClick={() => { decide("always"); }}>
            Always approve {tool}
          </Button>
        ) : null}
        <Button size="sm" variant="destructive" disabled={answering} onClick={() => { decide("deny"); }}>
          Deny
        </Button>
      </div>
    </div>
  );
}
