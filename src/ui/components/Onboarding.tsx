import { useEffect, useState } from "react";
import { IconKey, IconX } from "@tabler/icons-react";
import { primaryModifierLabel } from "../platform";
import styles from "./Onboarding.module.css";

export type OnboardingStep =
  | "open-search"
  | "type-first"
  | "play-first"
  | "new-tab"
  | "type-second"
  | "play-second"
  | "switch-back";

function getStepContent(): Record<
  OnboardingStep,
  { text: string; target: string; shortcut?: string }
> {
  return {
  "open-search": {
    text: `Press ${primaryModifierLabel} Space, or click the search bar.`,
    target: '[data-onboarding="search"]',
    shortcut: `${primaryModifierLabel} Space`,
  },
  "type-first": {
    text: "Enter one of your favorite songs.",
    target: '[data-onboarding="search-panel"]',
    shortcut: `${primaryModifierLabel} Space`,
  },
  "play-first": {
    text: "Play the song.",
    target: '[data-onboarding="search-panel"], [data-onboarding="search-results"]',
  },
  "new-tab": {
    text: "Open a new tab to keep this song playing here.",
    target: '[data-onboarding="new-tab"]',
    shortcut: `${primaryModifierLabel} T`,
  },
  "type-second": {
    text: "Search for another song in this new tab.",
    target: '[data-onboarding="search-panel"]',
    shortcut: `${primaryModifierLabel} Space`,
  },
  "play-second": {
    text: "Play it. This tab now has its own music.",
    target: '[data-onboarding="search-panel"], [data-onboarding="search-results"]',
  },
  "switch-back": {
    text: "Switch back. Your first song is still in its tab.",
    target: '[data-onboarding="first-tab"]',
    shortcut: `${primaryModifierLabel} 1, 2, 3...`,
  },
  };
}

interface OnboardingProps {
  step: OnboardingStep;
  onSkip: () => void;
}

export function Onboarding({ step, onSkip }: OnboardingProps) {
  const [typedText, setTypedText] = useState("");
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const content = getStepContent()[step];
  const padding = 8;
  const left = targetRect ? Math.max(0, targetRect.left - padding) : 0;
  const top = targetRect ? Math.max(0, targetRect.top - padding) : 0;
  const right = targetRect
    ? Math.min(window.innerWidth, targetRect.right + padding)
    : 0;
  const bottom = targetRect
    ? Math.min(window.innerHeight, targetRect.bottom + padding)
    : 0;

  useEffect(() => {
    setTypedText("");
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setTypedText(content.text.slice(0, index));
      if (index >= content.text.length) window.clearInterval(timer);
    }, 22);
    return () => window.clearInterval(timer);
  }, [content.text]);

  useEffect(() => {
    const updateTarget = () => {
      const target = document.querySelector<HTMLElement>(content.target);
      setTargetRect(target?.getBoundingClientRect() ?? null);
    };
    updateTarget();
    const timer = window.setInterval(updateTarget, 120);
    window.addEventListener("resize", updateTarget);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", updateTarget);
    };
  }, [content.target]);

  return (
    <div className={styles.layer} aria-live="polite">
      {targetRect && (
        <>
          <div className={styles.scrimTop} style={{ height: top }} />
          <div
            className={styles.scrimLeft}
            style={{
              top,
              width: left,
              height: bottom - top,
            }}
          />
          <div
            className={styles.scrimRight}
            style={{
              top,
              left: right,
              height: bottom - top,
            }}
          />
          <div className={styles.scrimBottom} style={{ top: bottom }} />
          <div
            className={styles.spotlightGlow}
            style={{
              left,
              top,
              width: right - left,
              height: bottom - top,
            }}
          />
          <div
            className={styles.spotlight}
            style={{
              left,
              top,
              width: right - left,
              height: bottom - top,
            }}
          />
        </>
      )}
      <button
        className={styles.skip}
        type="button"
        onClick={onSkip}
        aria-label="Skip onboarding"
        title="Skip onboarding"
      >
        <span>Close onboarding</span>
        <IconX size={19} />
      </button>
      <div className={styles.prompt}>
        {step === "open-search" && <span className={styles.step}>Quick start</span>}
        <p>{typedText}<span className={styles.caret} /></p>
        {content.shortcut && <kbd className={styles.shortcut}>{content.shortcut}</kbd>}
      </div>
    </div>
  );
}

export function OnboardingCompleteToast() {
  return (
    <div className={styles.completeToast} role="status">
      <span className={styles.completeLabel}>Onboarding</span>
      <strong>Complete</strong>
    </div>
  );
}

export function OnboardingWelcome() {
  return (
    <div className={styles.welcome} role="status" aria-label="Welcome">
      <div className={styles.welcomeAmbient} />
      <div className={styles.welcomeText}>
        <strong>Welcome</strong>
      </div>
    </div>
  );
}

interface KeychainNoticeProps {
  onContinue: () => void;
}

export function KeychainNotice({ onContinue }: KeychainNoticeProps) {
  return (
    <div className={styles.keychainNotice} role="dialog" aria-modal="true" aria-labelledby="keychain-title">
      <div className={styles.keychainAmbient} />
      <div className={styles.keychainCard}>
        <span className={styles.keychainIcon} aria-hidden="true">
          <IconKey size={28} />
        </span>
        <h1 id="keychain-title">A note about macOS Keychain</h1>
        <p>
          This Client uses Keychain to protect the encryption key for your
          YouTube Music session cookie. macOS may ask for permission when you continue.
        </p>
        <p>
          The app only accesses the Keychain item it created for this purpose. It does not
          request access to your passwords or any other Keychain items. You can also deny this but signing in with YT Music will not work then!
        </p>
        <p>
          <strong>
If you want for the popup to go away click "always allow"
        </strong>
        
        </p>
        <button type="button" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
