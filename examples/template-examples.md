# Template Examples

This document provides comprehensive examples of how to create custom templates for the Auto Note Importer plugin.

## Basic Template Structure

Templates use `{{fieldName}}` placeholders that get replaced with actual data from your Airtable records.

### Simple Template Example

```markdown
---
title: "{{Title}}"
status: "{{Status}}"
created: "{{Created time}}"
---

# {{Title}}

{{Description}}
```

## Advanced Template Features

### 1. Nested Field Access

For complex fields like Attachments or Users, use dot notation:

```markdown
---
title: "{{Title}}"
author: "{{Author.name}}"
email: "{{Author.email}}"
attachment: "{{Attachments.0.url}}"
filename: "{{Attachments.0.filename}}"
---

# {{Title}}

**Author:** {{Author.name}} ({{Author.email}})

## Attachments
- [{{Attachments.0.filename}}]({{Attachments.0.url}})
```

### 2. Multi-line Content Handling

For fields with multi-line content, the plugin automatically handles YAML formatting:

```markdown
---
title: "{{Title}}"
summary: |
  {{Summary}}
tags: {{Tags}}
---

# {{Title}}

## Summary
{{Summary}}

## Full Content
{{Content}}
```

### 3. Obsidian Bases Optimized Template

Template optimized for Obsidian Bases table/card views:

```markdown
---
title: "{{Title}}"
status: "{{Status}}"
priority: {{Priority}}
created: "{{Created time}}"
category: "{{Category}}"
assignee: "{{Assignee.name}}"
progress: {{Progress}}
due_date: "{{Due date}}"
tags: [{{Tags}}]
---

# {{Title}}

**Status:** {{Status}}  
**Priority:** {{Priority}}  
**Assigned to:** {{Assignee.name}}  
**Due:** {{Due date}}

## Description
{{Description}}

## Notes
{{Notes}}

## Related Files
{{#each Attachments}}
- [{{filename}}]({{url}})
{{/each}}
```

## Field Type Specific Examples

### Working with Arrays

```markdown
---
title: "{{Title}}"
# Multiple select fields become arrays
categories: {{Categories}}
collaborators: {{Collaborators}}
---

# {{Title}}

**Categories:** {{Categories}}
**Team:** {{Collaborators}}
```

### Working with Dates

```markdown
---
title: "{{Title}}"
created: "{{Created time}}"
modified: "{{Last modified time}}"
due_date: "{{Due date}}"
---

# {{Title}}

**Created:** {{Created time}}  
**Last Modified:** {{Last modified time}}  
**Due Date:** {{Due date}}
```

### Working with Numbers and Ratings

```markdown
---
title: "{{Title}}"
score: {{Score}}
rating: {{Rating}}
price: {{Price}}
quantity: {{Quantity}}
---

# {{Title}}

**Score:** {{Score}}/100  
**Rating:** {{Rating}} stars  
**Price:** ${{Price}}  
**Quantity:** {{Quantity}}
```

## Use Case Templates

### 1. Project Management Template

```markdown
---
title: "{{Project Name}}"
status: "{{Status}}"
priority: "{{Priority}}"
lead: "{{Project Lead.name}}"
start_date: "{{Start Date}}"
end_date: "{{End Date}}"
budget: {{Budget}}
progress: {{Progress}}
---

# {{Project Name}}

**Status:** {{Status}}  
**Priority:** {{Priority}}  
**Project Lead:** {{Project Lead.name}}  
**Timeline:** {{Start Date}} → {{End Date}}  
**Budget:** ${{Budget}}  
**Progress:** {{Progress}}%

## Objective
{{Objective}}

## Key Deliverables
{{Deliverables}}

## Team Members
{{Team Members}}

## Resources
{{#each Attachments}}
- [{{filename}}]({{url}})
{{/each}}
```

### 2. Contact Management Template

```markdown
---
title: "{{Full Name}}"
company: "{{Company}}"
role: "{{Job Title}}"
email: "{{Email}}"
phone: "{{Phone}}"
location: "{{Location}}"
status: "{{Contact Status}}"
---

# {{Full Name}}

**Company:** {{Company}}  
**Role:** {{Job Title}}  
**Email:** {{Email}}  
**Phone:** {{Phone}}  
**Location:** {{Location}}  
**Status:** {{Contact Status}}

## Notes
{{Notes}}

## Meeting History
{{Meeting Notes}}

## Documents
{{#each Attachments}}
- [{{filename}}]({{url}})
{{/each}}
```

### 3. Content Management Template

```markdown
---
title: "{{Title}}"
author: "{{Author.name}}"
category: "{{Category}}"
status: "{{Status}}"
published: "{{Published Date}}"
tags: {{Tags}}
featured_image: "{{Featured Image.0.url}}"
---

# {{Title}}

![Featured Image]({{Featured Image.0.url}})

**Author:** {{Author.name}}  
**Category:** {{Category}}  
**Status:** {{Status}}  
**Published:** {{Published Date}}  
**Tags:** {{Tags}}

## Summary
{{Summary}}

## Content
{{Content}}

## SEO
**Meta Description:** {{Meta Description}}  
**Keywords:** {{Keywords}}
```

### 4. Inventory Management Template

```markdown
---
title: "{{Item Name}}"
sku: "{{SKU}}"
category: "{{Category}}"
quantity: {{Quantity}}
price: {{Price}}
supplier: "{{Supplier.name}}"
location: "{{Storage Location}}"
status: "{{Status}}"
---

# {{Item Name}}

**SKU:** {{SKU}}  
**Category:** {{Category}}  
**Quantity:** {{Quantity}}  
**Price:** ${{Price}}  
**Supplier:** {{Supplier.name}}  
**Location:** {{Storage Location}}  
**Status:** {{Status}}

## Description
{{Description}}

## Specifications
{{Specifications}}

## Images
{{#each Images}}
![{{filename}}]({{url}})
{{/each}}
```

## Template Best Practices

### 1. YAML Frontmatter Tips
- Use quotes for text fields: `"{{Text Field}}"`
- Numbers don't need quotes: `{{Number Field}}`
- Multi-line content uses block scalar: `|` syntax
- Arrays are handled automatically

### 2. Obsidian Integration
- Use standard YAML property names for better Bases compatibility
- Include `created`, `modified`, `status`, `tags` for common workflows
- Format dates as ISO strings for Dataview compatibility

### 3. Error Prevention
- Always provide fallback content for optional fields
- Test templates with various record types
- Use descriptive field names in Airtable for clearer templates

### 4. Performance Optimization
- Keep templates focused on essential information
- Use nested access sparingly ({{Object.property}})
- Organize frontmatter properties logically

## Troubleshooting Templates

### Common Issues

**Missing Field Output:** Field name doesn't match Airtable exactly
```markdown
<!-- Wrong -->
{{title}}

<!-- Correct -->
{{Title}}
```

**Multi-line YAML Issues:** Use block scalar for long text
```markdown
---
description: |
  {{Long Description}}
---
```

**Array Display:** Arrays are automatically formatted as `[item1, item2]`
```markdown
---
tags: {{Tags}}  # Becomes: [tag1, tag2, tag3]
---
```

**Nested Field Access:** Use dot notation for object properties
```markdown
<!-- Access first attachment URL -->
{{Attachments.0.url}}

<!-- Access user name -->
{{User.name}}
```

For more information about field types and compatibility, see [`airtable-field-types.md`](airtable-field-types.md).