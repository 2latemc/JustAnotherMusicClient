import type { Album, Playlist, Track } from "../../datasource/types";

export interface Tab {
  id: string;
  title?: string;
  view: "home" | "album" | "playlist" | "search" | "settings";
  album?: Album;
  playlist?: Playlist;
  searchQuery?: string;
  searchResults?: Track[];
  searchLoading?: boolean;
  isQueueOpen?: boolean;
}