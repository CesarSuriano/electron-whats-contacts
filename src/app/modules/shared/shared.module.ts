import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AppPageHeaderComponent } from '../../components/app-page-header/app-page-header.component';
import { MessageTemplateModalComponent } from '../../components/message-template-modal/message-template-modal.component';
import { ScheduleModalComponent } from '../../components/schedule-modal/schedule-modal.component';
import { ScheduleListModalComponent } from '../../components/schedule-list-modal/schedule-list-modal.component';
import { ScheduleNotificationComponent } from '../../components/schedule-notification/schedule-notification.component';

@NgModule({
  declarations: [
    AppPageHeaderComponent,
    MessageTemplateModalComponent,
    ScheduleModalComponent,
    ScheduleListModalComponent,
    ScheduleNotificationComponent
  ],
  imports: [CommonModule, FormsModule],
  exports: [
    AppPageHeaderComponent,
    MessageTemplateModalComponent,
    ScheduleModalComponent,
    ScheduleListModalComponent,
    ScheduleNotificationComponent
  ]
})
export class SharedModule {}
