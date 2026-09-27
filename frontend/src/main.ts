import { createApp } from "vue";
import "./style.css";
import App from "./App.vue";
import text from "./text/en.json";

document.title = text.brand.pageTitle;
createApp(App).mount("#app");
