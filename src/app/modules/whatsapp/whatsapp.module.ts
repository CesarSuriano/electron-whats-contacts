import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SharedModule } from '../shared/shared.module';
import { BulkActionBarComponent } from './components/bulk-action-bar/bulk-action-bar.component';
import { BulkTaskPanelComponent } from './components/bulk-task-panel/bulk-task-panel.component';
import { ChatHeaderComponent } from './components/chat-header/chat-header.component';
import { ChatViewComponent } from './components/chat-view/chat-view.component';
import { ComposerComponent } from './components/composer/composer.component';
import { ContactAvatarComponent } from './components/contact-avatar/contact-avatar.component';
import { ConversationListComponent } from './components/conversation-list/conversation-list.component';
import { MessageListComponent } from './components/message-list/message-list.component';
import { WhatsappConsoleComponent } from './components/whatsapp-console/whatsapp-console.component';
import { WhatsappPageComponent } from './pages/whatsapp-page/whatsapp-page.component';
import { WhatsappRoutingModule } from './whatsapp-routing.module';

@NgModule({
  declarations: [
    WhatsappPageComponent,
    WhatsappConsoleComponent,
    ConversationListComponent,
    ChatViewComponent,
    ChatHeaderComponent,
    MessageListComponent,
    ComposerComponent,
    ContactAvatarComponent,
    BulkActionBarComponent,
    BulkTaskPanelComponent
  ],
  imports: [CommonModule, FormsModule, WhatsappRoutingModule, SharedModule]
})
export class WhatsappModule {}
