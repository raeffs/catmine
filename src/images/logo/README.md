# Logo placeholder

Put the header logo here as `logo.png`.

Enabling it requires these overrides in `src/_custom-variables.scss`:

```scss
@use 'variables' with (
  $use-logo: true,
  $logo-image-width: 60px,   // actual pixel width of logo.png
  $logo-image-height: 40px   // actual pixel height of logo.png
);
```

If the logo is taller than 40px, also raise `$header-padding-vertical` from
its 10px default or the header will clip the image.

Everything under `src/images/` is copied into the built theme
(`dist/catmine/images/`), so replace this README with the real file when the
logo exists.
