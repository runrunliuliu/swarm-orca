import React from 'react'
import { Archive } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'

/** The one draft-only lifecycle item; the row's Delete item stays the existing path. */
export function WorktreeContextMenuArchiveDraftItem({
  disabled,
  onSelect
}: {
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <Archive className="size-3.5" />
      {translate('auto.components.sidebar.WorktreeContextMenu.archiveDraft', 'Archive draft')}
    </DropdownMenuItem>
  )
}
