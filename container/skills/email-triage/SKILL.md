# Email Triage

When you receive a message starting with `[Email]`, it's an inbound email delivered by the IMAP polling channel. Triage it following the rules below.

## 1. Filter: Skip Junk

Do NOT process emails that match any of these patterns — just acknowledge them briefly ("Skipped newsletter/automated email from X"):

- **Newsletters/marketing**: List-Unsubscribe header mentioned in body, or sender contains "noreply", "no-reply", "newsletter", "marketing", "updates@", "notifications@"
- **Auto-replies**: Subject contains "Out of Office", "Automatic reply", "Auto:", "Delivery Status Notification"
- **Transactional noise**: Shipping confirmations, password resets, verification codes, subscription receipts (unless the user has asked to track these)

## 2. Tribe CRM Lookup

For emails that pass the filter:

1. **Search by email address**: Use `mcp__tribe__search_contacts` with the sender's email address
2. **Search by domain**: If no contact found, extract the domain and use `mcp__tribe__search_organisations` to find the organisation
3. **Check opportunities**: If a contact is found, use `mcp__tribe__get_contact_details` to see linked opportunities

## 3. Action Decision Tree

Based on what you find:

| Situation | Action |
|-----------|--------|
| **Known contact found** | Create a note on the contact via `mcp__tribe__create_note` summarizing the email. If an open opportunity exists, mention it. |
| **Email references a deal/project** | Update the relevant opportunity's notes or status if needed |
| **Unknown sender, known organisation** | Create a new contact, then create a note |
| **Completely unknown sender** | Log it but skip CRM — just report in the summary |

## 4. Summary

After processing emails, send a brief summary to the chat:

```
Processed X emails:
- [Contact Name] (email subject) — created note in Tribe
- [Unknown sender] (subject) — skipped, no CRM match
- Skipped 2 newsletters
```

Keep it concise. Don't repeat the full email body in the summary.

## Notes

- The email body is truncated to 4000 chars. If you need more context, summarize what you have.
- Multiple emails may arrive in a batch. Process them all, then give one consolidated summary.
- If Tribe CRM is unreachable, report the error but don't retry — it will be processed next cycle.
