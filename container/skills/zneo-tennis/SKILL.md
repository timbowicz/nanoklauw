---
name: zneo-tennis
description: Reserve tennis courts at ZNEO (Zuid-Noordwolde e.o.) tennis club via their website. Handles login, partner selection, date/time selection, and confirmation.
---

# ZNEO Tennis Court Reservation Skill

This skill automates the process of reserving tennis courts at ZNEO tennis club (https://www.zneo.nl/).

## Prerequisites

- User must have ZNEO club credentials (club number and password)
- User must be a member of ZNEO tennis club

## Usage

User can request: "Reserve a tennis court for [date] with [partner name]"

Example: "Reserve a tennis court for Friday with Paul van Dijk"

## Implementation Steps

### 1. Gather Information

Ask the user for:
- **Date**: Which day they want to play (e.g., "Friday", "next Monday", specific date)
- **Partner**: Who they want to play with (name)
- **Time preference** (optional): Morning (Ochtend), Afternoon (Middag), or Evening (Avond)
- **Credentials** (if not stored):
  - Club number (Clublidnummer)
  - Password

### 2. Launch Browser and Navigate

```bash
agent-browser open https://www.zneo.nl/
```

### 3. Login Process

1. Click on "Mijn Club" button
2. Wait for login page to load
3. Select "Clublidnummer" from dropdown (instead of "Bondsnummer")
4. Fill in club number field
5. Fill in password field
6. Click "Inloggen" button
7. Wait for dashboard to load

**Technical notes:**
- The club number field may be tricky to target - use JavaScript if needed:
  ```javascript
  document.querySelector('input[type="text"]:not([name="Name"]):not([name="ReplayTo"]):not([id="questionMessage"])').value = 'CLUBNUMBER'
  ```

### 4. Navigate to Court Reservations

1. Click on "Baan reserveringen" link
2. Click on "Baan afhangen" button to start new reservation

### 5. Step 1: Select Partners

1. User (Tim Koppers) is automatically selected
2. Search for partner in "Spelers" search box OR
3. Click on partner from "Recent mee gespeeld" section if available
4. Partner will appear in "Je gaat spelen met" section
5. Click "Volgende" button

### 6. Step 2: Select Date and Time

1. Calendar view shows current week with days (di, wo, do, vr, za, zo, ma)
2. Each day has three time blocks: Ochtend, Middag, Avond
3. Find the target day (e.g., "vr 27 februari")
4. Click on the desired time block (e.g., "Ochtend")
5. The selected block will turn blue
6. Click "Volgende" button

**Technical notes:**
- Days are shown as: "di 24", "wo 25", "vr 27", etc.
- To click a specific time block, use JavaScript to find the right element:
  ```javascript
  const buttons = Array.from(document.querySelectorAll('button'));
  const vrButton = buttons.find(b => b.textContent.includes('vr 27'));
  if (vrButton) {
    const parent = vrButton.parentElement;
    const allDivs = Array.from(parent.querySelectorAll('div'));
    const ochtendDivs = allDivs.filter(d => d.textContent.trim() === 'Ochtend');
    if (ochtendDivs.length > 0) {
      ochtendDivs[0].click();
    }
  }
  ```

### 7. Step 3: Select Court and Time

1. Grid shows available courts (1, 2) and time slots (08:00 - 21:00)
2. Click on desired time slot (e.g., "10:00" on court 1)
3. Selected slot will turn blue
4. Click "Volgende" button

### 8. Step 4: Confirm Reservation

1. Confirmation page shows:
   - "Je bent er bijna! Bevestig dat je baan X wilt reserveren op DD-MM-YYYY van HH:MM tot HH:MM"
   - Partner(s) listed under "Je gaat spelen met"
2. Click "Bevestigen" button using JavaScript:
   ```javascript
   document.getElementById('confirmReservationButton').click()
   ```
3. Wait for confirmation (page redirects to "Mijn boekingen")
4. Take screenshot of confirmed reservation

### 9. Verify and Report

1. Check that reservation appears in "Mijn boekingen" list
2. Take final screenshot
3. Report to user:
   - Date
   - Time
   - Court number
   - Partner name
4. Send screenshot if requested

## Common Issues and Solutions

### Issue: Date field is hard to target
**Solution:** Use JavaScript to set value directly or use XPath to locate the specific input.

### Issue: Multiple elements match selector
**Solution:** Be more specific with selectors or use nth-child, or filter by parent context.

### Issue: Time slot not clickable
**Solution:** Navigate the DOM hierarchy - find the day button first, then traverse to find the correct time slot div within that day's container.

### Issue: Confirmation button not in snapshot
**Solution:** Use `document.getElementById('confirmReservationButton').click()` directly.

## Testing Notes

- Courts are typically available from 08:00 to 21:00
- There are usually 2 courts (both Kunstgras/artificial grass)
- Reservations are made in 1-hour slots
- The system shows "Ochtend" (morning), "Middag" (afternoon), and "Avond" (evening) blocks

## Example Full Flow

```bash
# 1. Open website
agent-browser open https://www.zneo.nl/

# 2. Login
agent-browser snapshot -i
agent-browser click @e3  # Mijn Club
agent-browser wait 2000
agent-browser snapshot -i
agent-browser select @e13 "Clublidnummer"
agent-browser eval "document.querySelector('input[type=\"text\"]:not([name=\"Name\"])...').value = '10226'"
agent-browser fill @e17 "PASSWORD"
agent-browser click @e19  # Inloggen

# 3. Navigate to reservations
agent-browser wait 3000
agent-browser click @e15  # Baan reserveringen
agent-browser wait 2000
agent-browser click @e19  # Baan afhangen

# 4. Select partner
agent-browser wait 2000
agent-browser find text "Partner Name" click
agent-browser click @e25  # Volgende

# 5. Select date/time
agent-browser wait 2000
# Click on Friday Ochtend using JavaScript
agent-browser eval "/* JavaScript to select day/time */"
agent-browser find text "Volgende" click

# 6. Select court and time
agent-browser wait 2000
agent-browser click @e34  # 10:00 time slot
agent-browser scroll down 200
agent-browser find text "Volgende" click

# 7. Confirm
agent-browser wait 2000
agent-browser eval "document.getElementById('confirmReservationButton').click()"
agent-browser wait 3000

# 8. Screenshot and close
agent-browser screenshot
agent-browser close
```
