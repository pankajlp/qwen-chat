// Runs last, after every feature file has loaded.
updateCodeUI();
// Open the app with ?selftest to run the built-in self-test (see js/selftest.js)
if (new URLSearchParams(location.search).has('selftest')) loadScript('js/selftest.js');
