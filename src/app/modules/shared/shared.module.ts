import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MessageTemplateModalComponent } from '../../components/message-template-modal/message-template-modal.component';

@NgModule({
  declarations: [MessageTemplateModalComponent],
  imports: [CommonModule, FormsModule],
  exports: [MessageTemplateModalComponent]
})
export class SharedModule {}
