export interface QuickReply {
  id: string;
  shortcode: string;
  title?: string;
  content: string;
  imageDataUrls?: string[];
  updatedAt: string;
}

export interface QuickReplyDraft {
  shortcode: string;
  title?: string;
  content: string;
  imageDataUrls?: string[];
}
