// ====================================================================
// JAVASCRIPT/TYPESCRIPT CLASSES - CRASH COURSE
// ====================================================================

/\*
CLASSES = BLUEPRINTS FOR CREATING OBJECTS

Think of a class like a cookie cutter:

- The class is the cookie cutter shape
- Each object you create is a cookie

\*/

// ====================================================================
// 1. BASIC CLASS STRUCTURE
// ====================================================================

class Person {
// Properties (data the object holds)
name: string;
age: number;

// Constructor (runs when you create a new object)
constructor(name: string, age: number) {
this.name = name; // 'this' = the current object
this.age = age;
}

// Methods (functions the object can do)
greet() {
console.log(`Hi, I'm ${this.name} and I'm ${this.age} years old`);
}

haveBirthday() {
this.age++; // 'this' refers to the object
console.log(`Happy birthday! Now I'm ${this.age}`);
}
}

// Creating objects from the class
const alice = new Person('Alice', 25);
const bob = new Person('Bob', 30);

alice.greet(); // "Hi, I'm Alice and I'm 25 years old"
bob.greet(); // "Hi, I'm Bob and I'm 30 years old"

alice.haveBirthday(); // "Happy birthday! Now I'm 26"
console.log(alice.age); // 26
console.log(bob.age); // 30 (unchanged)

// ====================================================================
// 2. PROPERTY INITIALIZATION (What you're doing)
// ====================================================================

class BinanceClient {
// ✅ METHOD 1: Initialize in the class body (your approach)
private apiKey = 'my-api-key';
private secret = 'my-secret';

// No need for constructor if you initialize above!

getKey() {
return this.apiKey;
}
}

// ✅ METHOD 2: Initialize in constructor
class BinanceClient2 {
private apiKey: string;
private secret: string;

constructor(apiKey: string, secret: string) {
this.apiKey = apiKey;
this.secret = secret;
}

getKey() {
return this.apiKey;
}
}

// ✅ METHOD 3: Constructor shorthand (TypeScript only)
class BinanceClient3 {
constructor(
private apiKey: string, // Automatically creates this.apiKey
private secret: string // Automatically creates this.secret
) {
// Properties are automatically assigned!
}

getKey() {
return this.apiKey;
}
}

// ====================================================================
// 3. PUBLIC vs PRIVATE vs PROTECTED
// ====================================================================

class BankAccount {
// PUBLIC - accessible from anywhere (default)
public accountName: string;

// PRIVATE - only accessible inside this class
private balance: number = 0;

// PROTECTED - accessible in this class and subclasses
protected accountNumber: string;

constructor(name: string, accountNumber: string) {
this.accountName = name;
this.accountNumber = accountNumber;
}

// Public method - anyone can call this
deposit(amount: number) {
this.balance += amount; // ✅ Can access private property inside class
}

// Public method
getBalance() {
return this.balance; // ✅ Can access private property
}
}

const account = new BankAccount('Alice', '12345');
account.deposit(100);
console.log(account.getBalance()); // ✅ 100
console.log(account.accountName); // ✅ 'Alice' (public)
// console.log(account.balance); // ❌ ERROR - private property
// console.log(account.accountNumber); // ❌ ERROR - protected property

// ====================================================================
// 4. METHODS (Functions in classes)
// ====================================================================

class Calculator {
// Regular method
add(a: number, b: number): number {
return a + b;
}

// Async method
async fetchData(): Promise<string> {
return 'data';
}

// Private method (only usable inside class)
private validate(num: number): boolean {
return num >= 0;
}

// Method that uses another method
safeAdd(a: number, b: number): number {
if (this.validate(a) && this.validate(b)) {
return this.add(a, b); // Calling another method
}
throw new Error('Invalid numbers');
}
}

const calc = new Calculator();
console.log(calc.add(5, 3)); // ✅ 8
console.log(calc.safeAdd(5, 3)); // ✅ 8
// calc.validate(5); // ❌ ERROR - private method

// ====================================================================
// 5. THIS KEYWORD
// ====================================================================

class Counter {
private count = 0;

increment() {
// 'this' refers to the current Counter object
this.count++;
}

getCount() {
return this.count; // 'this.count' = this Counter's count
}

// Arrow function preserves 'this' context
incrementAsync = () => {
setTimeout(() => {
this.count++; // ✅ 'this' still refers to Counter
}, 1000);
}
}

const counter1 = new Counter();
const counter2 = new Counter();

counter1.increment();
counter1.increment();
console.log(counter1.getCount()); // 2

counter2.increment();
console.log(counter2.getCount()); // 1

// Each object has its own 'this' and own 'count'

// ====================================================================
// 6. REAL EXAMPLE - Your BinanceDataFetcher
// ====================================================================

import ccxt from 'ccxt';

class SimpleBinanceFetcher {
// Property - initialized when class is defined
private exchange = new ccxt.binance({
apiKey: 'key',
secret: 'secret',
});

// Method - can be called on any instance
async getPrice(symbol: string): Promise<number> {
const ticker = await this.exchange.fetchTicker(symbol);
return ticker.last || 0;
}

// Another method - uses 'this' to access exchange
async getBalance(): Promise<any> {
return await this.exchange.fetchBalance();
}
}

// Creating an instance
const fetcher = new SimpleBinanceFetcher();

// Calling methods on the instance
async function useIt() {
const price = await fetcher.getPrice('BTC/USDT');
const balance = await fetcher.getBalance();
}

// ====================================================================
// 7. COMMON PATTERNS
// ====================================================================

// Pattern 1: Singleton (only one instance)
class DatabaseConnection {
private static instance: DatabaseConnection;
private connected = false;

private constructor() {
// Private constructor prevents new DatabaseConnection()
}

static getInstance(): DatabaseConnection {
if (!DatabaseConnection.instance) {
DatabaseConnection.instance = new DatabaseConnection();
}
return DatabaseConnection.instance;
}

connect() {
this.connected = true;
}
}

// Usage
const db1 = DatabaseConnection.getInstance();
const db2 = DatabaseConnection.getInstance();
console.log(db1 === db2); // true - same instance

// Pattern 2: Dependency Injection (what you should do)
class TradingBot {
constructor(private dataFetcher: SimpleBinanceFetcher) {
// Receive dependencies through constructor
}

async run() {
const price = await this.dataFetcher.getPrice('BTC/USDT');
console.log(price);
}
}

// Usage
const myFetcher = new SimpleBinanceFetcher();
const bot = new TradingBot(myFetcher);

// ====================================================================
// 8. INHERITANCE (Not needed often, but good to know)
// ====================================================================

class Animal {
constructor(protected name: string) {}

makeSound() {
console.log('Some sound');
}
}

class Dog extends Animal {
constructor(name: string, private breed: string) {
super(name); // Call parent constructor
}

// Override parent method
makeSound() {
console.log('Woof!');
}

// New method only in Dog
fetch() {
console.log(`${this.name} is fetching!`);
}
}

const dog = new Dog('Buddy', 'Golden Retriever');
dog.makeSound(); // "Woof!"
dog.fetch(); // "Buddy is fetching!"

// ====================================================================
// KEY TAKEAWAYS
// ====================================================================

/\*

1. CLASS = Blueprint for creating objects
   - Properties = data the object holds
   - Methods = functions the object can do
   - Constructor = runs when creating new object

2. THIS = refers to the current object
   - this.property = access property on THIS object
   - this.method() = call method on THIS object

3. PUBLIC/PRIVATE/PROTECTED = who can access it
   - public = anyone
   - private = only inside this class
   - protected = this class + subclasses

4. CREATING OBJECTS: const obj = new ClassName(args)

5. YOUR CODE IS CORRECT! ✅
   You're using:
   - Property initialization (exchange = new ccxt.binance(...))
   - Private properties (private exchange)
   - Methods (async getCompleteTradingData())
   - This keyword (this.exchange.fetchTicker())
     \*/
