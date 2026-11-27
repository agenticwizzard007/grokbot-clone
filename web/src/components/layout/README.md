# Paper layout

Import `Page`, `Section`, `Card`, `Row` and `ButtonGroup` from this directory.

```tsx
<Page type="form" title="Settings">
  <Section title="Connections">
    <Card variant="list">
      <Row leading={<ProviderMark provider="claude" />} title="Claude"
        trailing={<button className="cfg-btn">Connect</button>} />
    </Card>
  </Section>
  <ButtonGroup stack><button>Cancel</button><button>Save</button></ButtonGroup>
</Page>
```

Page owns the outer gutters. Its content max-width is 640 (form), 880 (list), 760 (chat), or 1120 (wide, for dashboards), with 16 px phone gutters and 32 px desktop gutters outside the content column. Do not add route padding around it. Section owns header and vertical gaps. Use Card variant list for divided Row lists. Row wraps trailing controls at spaces on narrow screens. ButtonGroup divides its available width equally; stack makes every child full width on phones.

All primitives expose data-layout attributes. Add routes to tests/layout-alignment-ui.mjs, set their owner, and enable enforcement after migration. Unmigrated routes still run and report warnings in .context/layout-alignment/report.json. Run node tests/layout-primitives-ui.mjs to check all five required widths in both themes.

Customization preserves default geometry. Cards use --card-pad (16 or 24 px), section content uses --stack-gap (8, 16 or 24 px), and rows and buttons use --control-h. All viewports keep a 44 px control floor, including compact density; comfortable density uses 48 px. Body text and line heights scale together through --font-scale. Paper section headings retain their 13 px/18 px/600 style beside header actions.
