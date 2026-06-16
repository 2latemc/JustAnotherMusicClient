import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
} from "react";
import type { Artist, ArtistReference } from "../../datasource/types";
import { isMacOS } from "../platform";
import styles from "./ArtistLinks.module.css";

type NavigateArtist = (artist: Artist, openInNewTab: boolean) => void;

const ArtistNavigationContext = createContext<NavigateArtist | null>(null);

export function ArtistNavigationProvider({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate: NavigateArtist;
}) {
  return (
    <ArtistNavigationContext.Provider value={onNavigate}>
      {children}
    </ArtistNavigationContext.Provider>
  );
}

export function ArtistLinks({
  artists,
  fallback,
  className,
  interactive = true,
  suppressArtistId,
}: {
  artists?: ArtistReference[];
  fallback: string;
  className?: string;
  interactive?: boolean;
  suppressArtistId?: string;
}) {
  const navigate = useContext(ArtistNavigationContext);

  if (!navigate) {
    return <span className={className}>{fallback}</span>;
  }

  const openArtist = (
    event: MouseEvent<HTMLSpanElement> | KeyboardEvent<HTMLSpanElement>,
    artist: ArtistReference,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const hasPrimaryModifier = isMacOS ? event.metaKey : event.ctrlKey;
    const openInNewTab = "button" in event
      ? event.button === 1 || event.shiftKey || hasPrimaryModifier
      : event.shiftKey || hasPrimaryModifier;
    navigate({ id: artist.id, name: artist.name }, openInNewTab);
  };

  const isSuppressed = (artist: ArtistReference) =>
    suppressArtistId && artist.id === suppressArtistId;

  const renderArtist = (artist: ArtistReference) => {
    const suppressed = isSuppressed(artist);
    const isDisabled = !interactive || suppressed;
    return (
      <span className={`${styles.artistItem}${isDisabled ? ` ${styles.disabledItem}` : ""}`}>
        {isDisabled ? (
          <span className={styles.disabledLink}>
            {artist.name}
          </span>
        ) : (
          <span
            className={styles.link}
            role="link"
            tabIndex={0}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => openArtist(event, artist)}
            onAuxClick={(event) => {
              if (event.button === 1) openArtist(event, artist);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                openArtist(event, artist);
              }
            }}
          >
            {artist.name}
          </span>
        )}
      </span>
    );
  };

  const rendered = (() => {
    if (!artists?.length) {
      if (!fallback || fallback === "Unknown artist") {
        return <span className={className}>{fallback}</span>;
      }
      return (
        <span className={className}>
          {renderArtist({ id: "", name: fallback })}
        </span>
      );
    }

    return (
      <span className={className}>
        {artists.map((artist, index) => (
          <span key={`${artist.id}:${artist.name}`}>
            {index > 0 && ", "}
            {renderArtist(artist)}
          </span>
        ))}
      </span>
    );
  })();

  return <>{rendered}</>;
}