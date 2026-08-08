import { useEffect } from "react";
import { createPortal } from "react-dom";
import { IconExternalLink, IconX } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import styles from "./ReleaseChangelogModal.module.css";

interface ReleaseChangelogModalProps {
  version: string;
  changes: string;
  releaseUrl: string;
  onDismiss: () => void;
}

type ChangeBlock =
  | { type: "heading"; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

function cleanInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

function parseChangeBlocks(changes: string): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  const paragraphLines: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const text = cleanInlineMarkdown(paragraphLines.join(" "));
    if (text) blocks.push({ type: "paragraph", text });
    paragraphLines.length = 0;
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push({ type: "list", items: listItems });
    listItems = [];
  };

  for (const rawLine of changes.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const text = cleanInlineMarkdown(heading[1]);
      if (text) blocks.push({ type: "heading", text });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const text = cleanInlineMarkdown(bullet[1]);
      if (text) listItems.push(text);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

export function ReleaseChangelogModal({
  version,
  changes,
  releaseUrl,
  onDismiss,
}: ReleaseChangelogModalProps) {
  const blocks = parseChangeBlocks(changes);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  const modal = (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-changelog-title"
      >
        <button
          className={styles.closeButton}
          type="button"
          onClick={onDismiss}
          aria-label="Close changes"
          title="Close"
        >
          <IconX size={18} />
        </button>
        <div className={styles.header}>
          <h1 id="release-changelog-title">
            <span>Just Another Music Client</span>
            <span className={styles.titleDot} aria-hidden="true" />
            <span className={styles.version}>{version}</span>
          </h1>
        </div>
        <div className={styles.content}>
          {blocks.map((block, index) => {
            if (block.type === "heading") {
              return <h2 key={index}>{block.text}</h2>;
            }

            if (block.type === "list") {
              return (
                <ul key={index}>
                  {block.items.map((item, itemIndex) => (
                    <li key={`${index}-${itemIndex}`}>{item}</li>
                  ))}
                </ul>
              );
            }

            return <p key={index}>{block.text}</p>;
          })}
        </div>
        <div className={styles.footer}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void openUrl(releaseUrl)}
          >
            <IconExternalLink size={17} aria-hidden="true" />
            Release notes
          </button>
          <button className={styles.primaryButton} type="button" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </section>
    </div>
  );

  return createPortal(modal, document.body);
}
