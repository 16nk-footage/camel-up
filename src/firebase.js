import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDHO0dJnpgXsA2qbAQOjgoncbJKveOejn0",
  authDomain: "camelupfl.firebaseapp.com",
  databaseURL: "https://camelupfl-default-rtdb.firebaseio.com",
  projectId: "camelupfl",
  storageBucket: "camelupfl.firebasestorage.app",
  messagingSenderId: "877995317874",
  appId: "1:877995317874:web:651839f00b1c7f624840eb",
  measurementId: "G-24BFBVKC84"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
