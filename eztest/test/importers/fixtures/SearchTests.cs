using NUnit.Framework;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using OpenQA.Selenium.Support.UI;

namespace Shop.Tests
{
    [TestFixture]
    public class SearchTests
    {
        private IWebDriver driver;

        [SetUp]
        public void SetUp()
        {
            driver = new ChromeDriver();
            driver.Navigate().GoToUrl("http://localhost:4600/login");
        }

        [Test, Category("smoke")]
        public void SignInShowsDashboard()
        {
            driver.FindElement(By.Id("username")).SendKeys("bob");
            driver.FindElement(By.Id("password")).SendKeys("Builder#2");
            driver.FindElement(By.CssSelector("button[type=submit]")).Click();
            Assert.IsTrue(driver.Url.Contains("/dashboard"));
            Assert.AreEqual("bob", driver.FindElement(By.CssSelector("[data-testid=welcome-user]")).Text);
            var link = driver.FindElement(By.LinkText("New order"));
            link.Click();
            new SelectElement(driver.FindElement(By.Id("customer"))).SelectByText("Fabrikam Inc");
            Assert.That(driver.Title, Does.Contain("New order"));
            Assert.That(driver.FindElement(By.Id("qty")).GetAttribute("value"), Is.EqualTo("1"));
            driver.Url = "http://localhost:4600/dashboard";
            Assert.IsFalse(driver.FindElement(By.ClassName("err")).Displayed);
        }

        [TearDown]
        public void TearDown()
        {
            driver.Quit();
        }
    }
}
