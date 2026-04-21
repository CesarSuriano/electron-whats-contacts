import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AboutModalComponent } from '../../components/about-modal/about-modal.component';
import { AppPageHeaderComponent } from '../../components/app-page-header/app-page-header.component';
import { AppShellSidebarComponent } from '../../components/app-shell-sidebar/app-shell-sidebar.component';
import { MessageTemplateModalComponent } from '../../components/message-template-modal/message-template-modal.component';
import { ScheduleModalComponent } from '../../components/schedule-modal/schedule-modal.component';
import { ScheduleListModalComponent } from '../../components/schedule-list-modal/schedule-list-modal.component';
import { ScheduleNotificationComponent } from '../../components/schedule-notification/schedule-notification.component';

@NgModule({
  declarations: [
    AboutModalComponent,
    AppPageHeaderComponent,
    AppShellSidebarComponent,
    MessageTemplateModalComponent,
    ScheduleModalComponent,
    ScheduleListModalComponent,
    ScheduleNotificationComponent
  ],
  imports: [CommonModule, FormsModule],
  exports: [
    AboutModalComponent,
    AppPageHeaderComponent,
    AppShellSidebarComponent,
    MessageTemplateModalComponent,
    ScheduleModalComponent,
    ScheduleListModalComponent,
    ScheduleNotificationComponent
  ]
})
export class SharedModule {}
