# Airtable Field Type Support

This document explains how different Airtable field types are handled when imported into Obsidian, particularly through the template system using `{{fieldName}}` placeholders.

## Field Type Compatibility

| Field Type             | API Data Example                      | Template Output (`{{Field}}`) | Notes & Usage Tips                                                                                                                               |
| :--------------------- | :------------------------------------ | :---------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Text Types**         |                                       |                               |                                                                                                                                                  |
| Single line text       | `"Short text"`                        | `Short text`                  | ✅ **Safe for filenames/subfolders**. Outputs the text directly.                                                                                |
| Long text              | `"Line 1\nLine 2"`                    | `Line 1\nLine 2`              | Outputs the text, preserving line breaks. Use YAML block scalar for multi-line frontmatter.                                                  |
| Email                  | `"test@example.com"`                  | `test@example.com`            | ❌ **Not safe for filenames** (contains @). Outputs the email address text.                                                                     |
| URL                    | `"https://obsidian.md"`               | `https://obsidian.md`         | ❌ **Not safe for filenames** (contains :). Use Markdown syntax for clickable links.                                                           |
| Phone number           | `"+15551234567"`                      | `+15551234567`                | ❌ **Not safe for filenames** (contains +). Outputs the phone number text.                                                                      |
| **Number Types**       |                                       |                               |                                                                                                                                                  |
| Number                 | `123.45`                              | `123.45`                      | ✅ **Safe for filenames/subfolders**. Outputs the number as text.                                                                              |
| Currency               | `99.99`                               | `99.99`                       | ❌ **Not safe for filenames** (may include currency symbols). Outputs the numerical value.                                                      |
| Percent                | `0.75`                                | `0.75`                        | ❌ **Not safe for filenames** (may include % symbol). Outputs the decimal value (e.g., 75% is 0.75).                                          |
| Rating                 | `4`                                   | `4`                           | ❌ **Not safe for filenames** (may include star symbols). Outputs the rating number.                                                           |
| Autonumber             | `101`                                 | `101`                         | ❌ **Not recommended for filenames** (numbers alone aren't descriptive). Outputs the unique number.                                            |
| **Date & Time**        |                                       |                               |                                                                                                                                                  |
| Date                   | `"2023-10-27"` / `"2023-10-27T10:00Z"` | `2023-10-27` / `2023-10-27...`| ❌ **Not safe for filenames** (contains :). Compatible with Obsidian/Dataview YAML date fields.                                              |
| Created time           | `"2023-10-27T10:00:00.000Z"`          | `2023-10-27T10:00:00.000Z`    | ❌ **Not safe for filenames** (contains :). Outputs the timestamp string.                                                                       |
| Last modified time     | `"2023-10-27T11:30:00.000Z"`          | `2023-10-27T11:30:00.000Z`    | ❌ **Not safe for filenames** (contains :). Outputs the timestamp string.                                                                       |
| Duration               | `3665` (seconds)                      | `3665`                        | ❌ **Not safe for filenames** (time format contains :). Use Airtable Formula field for human-readable format if needed.                       |
| **Choice Types**       |                                       |                               |                                                                                                                                                  |
| Single select          | `"Option B"`                          | `Option B`                    | ✅ **Safe for filenames/subfolders**. Outputs the selected option text.                                                                        |
| Multiple select        | `["Option A", "Option C"]`            | `[Option A, Option C]`        | ❌ **Not safe for filenames** (array format). Outputs a string representation of the array.                                                    |
| Checkbox               | `true`                                | `true`                        | Outputs `"true"` or `"false"` string. Compatible with Obsidian/Dataview YAML boolean fields.                                                   |
| **Relational Types**   |                                       |                               |                                                                                                                                                  |
| Link to another record | `["recXXX", "recYYY"]`                | `[recXXX, recYYY]`            | ❌ **Not safe for filenames** (array format). **Recommendation:** Use a `Lookup` field in Airtable to get meaningful data.                   |
| Lookup                 | *Depends on lookup*                   | *Depends on lookup*           | Output depends on the looked-up field type. Arrays become `"[Value1, Value2]"`. Safe if lookup returns safe field type.                      |
| Rollup                 | *Depends on rollup*                   | *Depends on rollup*           | Output depends on the aggregation result. Arrays become `"[Value1, Value2]"`. Safe if rollup returns safe field type.                        |
| Count                  | `3`                                   | `3`                           | ❌ **Not recommended for filenames** (numbers alone aren't descriptive). Outputs the count number.                                             |
| **Attachment & User**  |                                       |                               |                                                                                                                                                  |
| Attachment             | `[{id:"att...", url:"...", ...}]`     | `[Object]`                    | ❌ **Not safe for filenames** (complex object). Use **dot notation** for details: `{{Attachment.0.url}}`, `{{Attachment.0.filename}}`.       |
| User                   | `{id:"usr...", email:"...", name:"..."}` | `[Object]`                    | ❌ **Not safe for filenames** (complex object). Use **dot notation** for details: `{{UserField.name}}`, `{{UserField.email}}`.              |
| Created by             | `{id:"usr...", ...}`                  | `[Object]`                    | ❌ **Not safe for filenames** (complex object). Use dot notation: `{{Created by.name}}`.                                                       |
| Last modified by       | `{id:"usr...", ...}`                  | `[Object]`                    | ❌ **Not safe for filenames** (complex object). Use dot notation: `{{Last modified by.name}}`.                                                 |
| **Special Types**      |                                       |                               |                                                                                                                                                  |
| Barcode                | `{text: "123"}`                       | `[Object]`                    | ❌ **Not safe for filenames** (complex object). Use dot notation: `{{BarcodeField.text}}`.                                                     |
| Button                 | *N/A (UI only)*                       | *N/A*                         | Button fields are UI elements in Airtable and do not return data via the API.                                                                  |
| Formula                | *Depends on formula*                  | *Depends on formula*          | ❌ **Not safe for filenames** (unpredictable results). Output depends on the formula result type.                                              |

## Plugin Field Type Restrictions

The Auto Note Importer plugin restricts field selection for filenames and subfolders to ensure safe file system operations:

### ✅ Allowed Field Types
- **Single line text**: Safe, descriptive, no special characters
- **Single select**: Predefined options, safe for organization
- **Number**: Simple numeric values

### ❌ Blocked Field Types
All other field types are automatically hidden in the dropdown selectors to prevent:
- **File system errors**: Special characters (`:`, `@`, `/`, etc.)
- **Unpredictable results**: Formula fields that may change
- **Poor organization**: Complex data types that don't work well as folder names

## Best Practices

### For Filenames
1. **Use descriptive text fields**: `title`, `name`, `subject`
2. **Avoid auto-generated fields**: `autonumber`, `created time`
3. **Keep it simple**: Single line text works best

### for Subfolders
1. **Use categorical fields**: `status`, `category`, `department`
2. **Choose stable values**: Fields that don't change frequently
3. **Consider hierarchy**: Use fields that create logical organization

### For Complex Data
- **Use dot notation** in templates: `{{Attachment.0.url}}`
- **Lookup meaningful data**: Instead of record IDs, lookup display names
- **Format dates properly**: Use Airtable formulas to format dates as needed

## Template Examples

See [`template-examples.md`](template-examples.md) for comprehensive template usage examples with different field types.