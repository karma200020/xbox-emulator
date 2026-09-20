import {
  isRuntimeMessage,
  type OverlayProfileSummary,
  type RuntimeMessage,
} from "./protocol";
import { t } from "./i18n";

type OverlayState = Extract<RuntimeMessage, { type: "overlay_state" }>;

export interface QuickOverlayClient {
  getState(): Promise<OverlayState | null>;
  selectProfile(profileId: string, associate: boolean): Promise<OverlayState | null>;
  saveSensitivity(
    profileId: string,
    values: { hip_x: number; hip_y: number; ads_x: number; ads_y: number },
  ): Promise<OverlayState | null>;
}

export class QuickOverlay {
  private panel: HTMLDivElement | null = null;
  private state: OverlayState | null = null;
  private profileSelect: HTMLSelectElement | null = null;
  private gameText: HTMLElement | null = null;
  private captureText: HTMLElement | null = null;
  private matchText: HTMLElement | null = null;
  private statusText: HTMLElement | null = null;
  private requestGeneration = 0;
  private previousFocus: HTMLElement | null = null;
  private fields: Record<"hip_x" | "hip_y" | "ads_x" | "ads_y", HTMLInputElement> | null = null;

  constructor(
    private readonly document: Document,
    private readonly client: QuickOverlayClient,
  ) {}

  isOpen(): boolean {
    return this.panel !== null;
  }

  async show(parent: Element, initialState?: OverlayState, focus = true): Promise<void> {
    const generation = ++this.requestGeneration;
    this.previousFocus = this.document.activeElement instanceof HTMLElement
      ? this.document.activeElement
      : null;
    this.ensurePanel();
    this.panel!.setAttribute("aria-modal", String(focus));
    if (this.panel!.parentElement !== parent) parent.append(this.panel!);
    if (!this.panel!.matches(":popover-open")) this.panel!.showPopover();
    const state = initialState ?? await this.client.getState();
    if (!this.panel || generation !== this.requestGeneration) return;
    if (state) this.render(state);
    else this.setStatus(t("profileUnavailable"), true);
    if (focus) this.profileSelect?.focus();
  }

  close(): void {
    this.requestGeneration += 1;
    if (!this.panel) return;
    if (this.panel.matches(":popover-open")) this.panel.hidePopover();
    this.panel.remove();
    this.panel = null;
    this.state = null;
    this.profileSelect = null;
    this.fields = null;
    this.gameText = null;
    this.captureText = null;
    this.matchText = null;
    this.statusText = null;
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  async refresh(state?: OverlayState): Promise<void> {
    if (!this.panel) return;
    const generation = ++this.requestGeneration;
    const next = state ?? await this.client.getState();
    if (this.panel && generation === this.requestGeneration && next) this.render(next);
  }

  private ensurePanel(): void {
    if (this.panel) return;
    const panel = this.document.createElement("div");
    panel.popover = "manual";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("quickSettingsLabel"));
    panel.setAttribute("aria-modal", "false");
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "50%",
      top: "50%",
      width: "min(520px, calc(100vw - 32px))",
      maxHeight: "calc(100vh - 32px)",
      overflow: "auto",
      transform: "translate(-50%, -50%)",
      margin: "0",
      padding: "20px",
      color: "#f0f6fc",
      background: "#161b22",
      border: "2px solid #56c256",
      borderRadius: "10px",
      boxShadow: "0 12px 48px #000c",
      font: "14px/1.45 system-ui, sans-serif",
    });

    const heading = this.text("h2", t("extensionName"));
    Object.assign(heading.style, { margin: "0 0 12px", fontSize: "20px" });
    this.gameText = this.text("p", t("detectedGame", t("unknown")));
    this.captureText = this.text("p", t("captureLabel", t("inactive")));
    this.matchText = this.text("p", "");

    const profileLabel = this.label(t("profileLabel"));
    this.profileSelect = this.document.createElement("select");
    this.styleControl(this.profileSelect);
    this.profileSelect.addEventListener("change", () => this.renderSensitivity());
    profileLabel.append(this.profileSelect);

    const sensitivityGrid = this.document.createElement("div");
    Object.assign(sensitivityGrid.style, {
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(120px, 1fr))",
      gap: "10px",
      marginTop: "12px",
    });
    this.fields = {
      hip_x: this.sensitivityInput(t("hipX")),
      hip_y: this.sensitivityInput(t("hipY")),
      ads_x: this.sensitivityInput(t("adsX")),
      ads_y: this.sensitivityInput(t("adsY")),
    };
    sensitivityGrid.append(
      ...Object.entries(this.fields).map(([key, input]) => {
        const labels: Record<string, string> = {
          hip_x: t("hipX"), hip_y: t("hipY"), ads_x: t("adsX"), ads_y: t("adsY"),
        };
        const field = this.label(labels[key]!);
        field.append(input);
        return field;
      }),
    );

    const actions = this.document.createElement("div");
    Object.assign(actions.style, {
      display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "16px",
    });
    const apply = this.button(t("useProfile"));
    const save = this.button(t("saveSensitivity"));
    const close = this.button(t("close"), true);
    apply.addEventListener("click", () => void this.applyProfile());
    save.addEventListener("click", () => void this.saveSensitivity());
    close.addEventListener("click", () => this.close());
    actions.append(apply, save, close);
    this.statusText = this.text("p", "");
    this.statusText.setAttribute("role", "status");
    this.statusText.setAttribute("aria-live", "polite");
    Object.assign(this.statusText.style, { minHeight: "20px", margin: "12px 0 0", color: "#7ee787" });
    panel.append(
      heading, this.gameText, this.captureText, this.matchText, profileLabel,
      sensitivityGrid, actions, this.statusText,
    );
    this.panel = panel;
    panel.addEventListener("keydown", (event) => this.onPanelKey(event));
  }

  private render(state: OverlayState): void {
    this.state = state;
    this.gameText!.textContent = state.identity
      ? t("detectedGame", `${state.identity.title_name} (${state.identity.product_id})`)
      : t("detectedGame", t("unknown"));
    this.captureText!.textContent = t("captureLabel", t(state.capture_active ? "active" : "inactive"));
    this.matchText!.textContent = state.match === "ambiguous"
      ? t("ambiguousMatch")
      : state.match === "matched"
        ? t("uniqueMatch")
        : t("noMatch");
    this.profileSelect!.replaceChildren(...state.profiles.map((profile) => {
      const option = this.document.createElement("option");
      option.value = profile.id;
      option.textContent = state.candidate_profile_ids.includes(profile.id) && state.match === "ambiguous"
        ? `${profile.name} (${t("matchSuffix")})` : profile.name;
      option.selected = profile.id === state.active_profile_id;
      return option;
    }));
    this.renderSensitivity();
    this.setStatus("");
  }

  private renderSensitivity(): void {
    const profile = this.selectedProfile();
    if (!profile || !this.fields) return;
    for (const key of Object.keys(this.fields) as (keyof typeof this.fields)[]) {
      this.fields[key].value = String(profile[key]);
    }
  }

  private async applyProfile(): Promise<void> {
    if (!this.profileSelect || !this.state) return;
    const generation = ++this.requestGeneration;
    const next = await this.client.selectProfile(
      this.profileSelect.value,
      this.state.identity !== null,
    );
    if (!this.panel || generation !== this.requestGeneration) return;
    if (!next) {
      this.setStatus(t("profileRejected"), true);
      return;
    }
    this.render(next);
    this.setStatus(t("profileSavedRestart"));
  }

  private async saveSensitivity(): Promise<void> {
    if (!this.profileSelect || !this.fields) return;
    const values = {
      hip_x: this.fields.hip_x.valueAsNumber,
      hip_y: this.fields.hip_y.valueAsNumber,
      ads_x: this.fields.ads_x.valueAsNumber,
      ads_y: this.fields.ads_y.valueAsNumber,
    };
    if (!Object.values(values).every(isSensitivityValue)) {
      this.setStatus(t("sensitivityRange"), true);
      return;
    }
    const generation = ++this.requestGeneration;
    const next = await this.client.saveSensitivity(this.profileSelect.value, values);
    if (!this.panel || generation !== this.requestGeneration) return;
    if (!next) {
      this.setStatus(t("sensitivityRejected"), true);
      return;
    }
    this.render(next);
    this.setStatus(t("sensitivitySaved"));
  }

  private selectedProfile(): OverlayProfileSummary | undefined {
    return this.state?.profiles.find(({ id }) => id === this.profileSelect?.value);
  }

  private sensitivityInput(label: string): HTMLInputElement {
    const input = this.document.createElement("input");
    input.type = "number";
    input.min = "0.001";
    input.max = "0.2";
    input.step = "0.001";
    input.setAttribute("aria-label", label);
    this.styleControl(input);
    return input;
  }

  private label(text: string): HTMLLabelElement {
    const label = this.document.createElement("label");
    label.textContent = text;
    Object.assign(label.style, { display: "grid", gap: "5px", color: "#c9d1d9" });
    return label;
  }

  private button(text: string, secondary = false): HTMLButtonElement {
    const button = this.document.createElement("button");
    button.type = "button";
    button.textContent = text;
    Object.assign(button.style, {
      minHeight: "38px",
      padding: "7px 12px",
      color: "#fff",
      background: secondary ? "#30363d" : "#107c10",
      border: "1px solid #6e7681",
      borderRadius: "6px",
      font: "600 14px system-ui, sans-serif",
      cursor: "pointer",
    });
    return button;
  }

  private text<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    value: string,
  ): HTMLElementTagNameMap[K] {
    const element = this.document.createElement(tag);
    element.textContent = value;
    Object.assign(element.style, { margin: "0 0 8px" });
    return element;
  }

  private styleControl(element: HTMLElement): void {
    Object.assign(element.style, {
      width: "100%",
      minHeight: "38px",
      padding: "7px 9px",
      color: "#f0f6fc",
      background: "#0d1117",
      border: "1px solid #6e7681",
      borderRadius: "5px",
      font: "14px system-ui, sans-serif",
    });
    element.addEventListener("focus", () => {
      element.style.outline = "3px solid #58a6ff";
      element.style.outlineOffset = "2px";
    });
    element.addEventListener("blur", () => {
      element.style.outline = "";
      element.style.outlineOffset = "";
    });
  }

  private onPanelKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== "Tab" || !this.panel || this.panel.getAttribute("aria-modal") !== "true") return;
    const controls = [...this.panel.querySelectorAll<HTMLElement>("button, select, input")];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && this.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && this.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private setStatus(message: string, error = false): void {
    if (!this.statusText) return;
    this.statusText.textContent = message;
    this.statusText.style.color = error ? "#ffb4ab" : "#7ee787";
  }
}

export function parseOverlayState(value: unknown): OverlayState | null {
  return isRuntimeMessage(value) && value.type === "overlay_state" ? value : null;
}

export function isSensitivityValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0.001 && value <= 0.2;
}
