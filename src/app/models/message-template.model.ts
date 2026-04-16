export type MessageTemplateType = 'birthday' | 'review';

export interface MessageTemplates {
  birthday: string;
  review: string;
}

export interface MessageTemplateImages {
  birthday?: string;
  review?: string;
}

export interface MessageTemplateEditorConfig {
  type: MessageTemplateType;
  title: string;
  description: string;
}

export interface MessageTemplateSaveResult {
  text: string;
  imageDataUrl?: string;
}