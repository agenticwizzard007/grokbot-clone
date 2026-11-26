/** Names can veto a read attestation, but never grant one. */
const WRITE_VERBS = new Set(`CREATE UPDATE DELETE REMOVE SEND POST PUBLISH UNPUBLISH WRITE EDIT PATCH PUT INSERT UPSERT ADD APPEND UPLOAD IMPORT MOVE COPY DUPLICATE TRASH UNTRASH ARCHIVE UNARCHIVE MODIFY SET UNSET MARK UNMARK ASSIGN UNASSIGN INVITE REVOKE GRANT SHARE UNSHARE REPLY FORWARD REACT UNREACT LIKE UNLIKE FOLLOW UNFOLLOW SUBSCRIBE UNSUBSCRIBE JOIN LEAVE KICK BAN PIN UNPIN SCHEDULE CANCEL BOOK RESERVE PURCHASE PAY CHARGE REFUND SUBMIT EXECUTE RUN TRIGGER START STOP ENABLE DISABLE RESTORE REPLACE RENAME MERGE CLOSE REOPEN ACCEPT APPROVE REJECT DISMISS OPEN ATTACH DETACH DESTROY COMMIT DEPLOY TRANSFER INVOKE DISPATCH CONNECT DISCONNECT DRAFT`.split(' '));
const READ_VERBS = new Set('GET LIST SEARCH FETCH FIND READ RETRIEVE QUERY LOOKUP CHECK DESCRIBE VIEW COUNT'.split(' '));

export function isExternalAppWrite(name: string): boolean {
  const words = name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().split(/[^A-Z0-9]+/);
  return words.some((word, index) => {
    if (!WRITE_VERBS.has(word)) return false;
    // These are resource nouns: retrieving a post or draft does not publish it.
    if (['POST', 'DRAFT'].includes(word) && READ_VERBS.has(words[index - 1])) return false;
    // Gmail's SendAs resource contains sender settings, not a send operation.
    if (word === 'SEND' && words[index + 1] === 'AS' && READ_VERBS.has(words[index - 1])) return false;
    return true;
  });
}

/** Shared Standard/CLI boundary. API approval levels can compose with this helper. */
export function isExternalOnBehalfAction(name: string, args: any, attestedReadOnly = false): boolean {
  if (name === 'present_draft') return false;
  if (name === 'deliver_artifact') return args?.channel !== 'library';
  if (name === 'retry_delivery') return true;
  if (name === 'SWARM_APPS_EXECUTE') return !attestedReadOnly || isExternalAppWrite(String(args?.tool_slug ?? ''));
  return false;
}
