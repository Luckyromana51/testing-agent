# GLV Step Recorder

A small Chrome extension, made by GLV, that turns your clicks and typing into journey steps for the GLV testing platform.

1. Download it from a project's Journeys tab (Record steps), or zip this folder yourself.
2. Unzip it. In Chrome open `chrome://extensions`, turn on Developer mode, press **Load unpacked** and pick the `glv-recorder` folder.
3. Open the client's app, press the GLV icon, then **Record**. Use the app as a person would. Alt+click any text to add a "see" check.
4. Press **Copy** and paste the steps into a journey on the project page.

Passwords are written as `{{password}}` and two-step codes as `{{code}}`, so no secret is kept in the steps. Nothing is sent anywhere: the steps stay in your browser until you copy them.
